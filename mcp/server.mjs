#!/usr/bin/env node
/**
 * zcode-loop MCP server (stdio, newline-delimited JSON-RPC).
 *
 * The tools carry the mechanism — timing, metric parsing, git keep/revert and
 * the ledger — while the agent carries the judgement: which hypothesis to try
 * next and whether a result is meaningful.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loopPaths } from '../lib/paths.mjs'
import {
  DEFAULT_BUDGET,
  appendRow,
  nextHint,
  rebuildState,
  stopReason,
} from '../lib/ledger.mjs'
import {
  improvementPct,
  isLockedCommand,
  judgeConfidence,
  median,
  parseMetrics,
  truncateTail,
} from '../lib/stats.mjs'
import { checkConstraints, validateTrial } from '../lib/audit.mjs'
import {
  commitAll,
  currentBranch,
  ensureIgnored,
  isDirty,
  isRepo,
  recentLog,
  rollbackAll,
} from '../lib/gitops.mjs'
import { renderHtml, renderMarkdown } from '../lib/report.mjs'

const PLUGIN_VERSION = '0.1.0'
const PROJECT_DIR = process.env.ZCODE_PROJECT_DIR || process.cwd()
const PATHS = loopPaths(PROJECT_DIR)

const BENCH_TIMEOUT_MS = Number(process.env.ZLOOP_BENCH_TIMEOUT_MS) || 600_000
const GATE_TIMEOUT_MS = Number(process.env.ZLOOP_GATE_TIMEOUT_MS) || 300_000
const MAX_TAIL_LINES = 12
const MAX_TAIL_BYTES = 4096
const SPILL_THRESHOLD_BYTES = 2 * 1024 * 1024
const TAIL_CAP_BYTES = 64 * 1024
const KILL_GRACE_MS = 5_000

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}
function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}
function log(...args) {
  process.stderr.write(`[zcode-loop] ${args.join(' ')}\n`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    void dispatch(message)
  }
})

async function dispatch(message) {
  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'zcode-loop', version: PLUGIN_VERSION },
      instructions:
        'zcode-loop 让 agent 在固定度量上自主迭代：loop_run 跑基准，loop_commit 记录 keep/revert，账本在 .zloop/ledger.jsonl。',
    })
    return
  }
  if (message.method === 'notifications/initialized') return
  if (message.method === 'ping') {
    reply(message.id, {})
    return
  }
  if (message.method === 'tools/list') {
    reply(message.id, { tools: TOOLS })
    return
  }
  if (message.method === 'resources/list') {
    reply(message.id, { resources: [] })
    return
  }
  if (message.method === 'prompts/list') {
    reply(message.id, { prompts: [] })
    return
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name ?? ''
    const args = message.params?.arguments ?? {}
    const handler = HANDLERS[name]
    if (!handler) {
      replyError(message.id, -32601, `unknown tool: ${name}`)
      return
    }
    try {
      const result = await handler(args)
      reply(message.id, {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      })
    } catch (error) {
      replyError(message.id, -32000, error instanceof Error ? error.message : String(error))
    }
    return
  }
  if (message.method === 'exit') process.exit(0)
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

function killTree(child) {
  if (child.pid == null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
}

function runShell(command, timeoutMs, cwd) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('bash', ['-c', command], {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks = []
    const tail = []
    const metricLines = []
    let totalBytes = 0
    let tailBytes = 0
    let spillFile = null
    let carry = ''
    let timedOut = false

    const onData = (data) => {
      totalBytes += data.length
      if (!spillFile) {
        chunks.push(data)
        if (totalBytes > SPILL_THRESHOLD_BYTES) {
          spillFile = join(tmpdir(), `zloop-bench-${process.pid}-${Date.now()}.log`)
          writeFileSync(spillFile, Buffer.concat(chunks))
          chunks.length = 0
        }
      } else {
        try {
          appendFileSync(spillFile, data)
        } catch {
          /* ignore */
        }
      }
      tail.push(data)
      tailBytes += data.length
      while (tailBytes > TAIL_CAP_BYTES && tail.length > 0) {
        const excess = tailBytes - TAIL_CAP_BYTES
        const first = tail[0]
        if (first.length <= excess) {
          tailBytes -= first.length
          tail.shift()
        } else {
          tail[0] = first.subarray(excess)
          tailBytes -= excess
        }
      }
      carry += data.toString('utf8')
      const lines = carry.split('\n')
      carry = lines.pop() ?? ''
      if (carry.length > TAIL_CAP_BYTES) carry = carry.slice(-TAIL_CAP_BYTES)
      for (const line of lines) {
        if (line.trim().startsWith('METRIC ') && metricLines.length < 1000) metricLines.push(line)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    let killTimer = null
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      killTimer = setTimeout(() => killTree(child), KILL_GRACE_MS)
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({
        exitCode: null,
        durationMs: Date.now() - started,
        output: '',
        outputTail: `[benchmark failed to start: ${error.message}]`,
        logFile: null,
        timedOut: false,
      })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      const full = Buffer.concat(chunks).toString('utf8')
      resolve({
        exitCode: code,
        signal: signal ?? null,
        durationMs: Date.now() - started,
        output: spillFile ? metricLines.join('\n') : full,
        outputTail: spillFile ? Buffer.concat(tail).toString('utf8') : full,
        logFile: spillFile,
        timedOut,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// state helpers
// ---------------------------------------------------------------------------

function state() {
  return rebuildState(PROJECT_DIR, PATHS)
}

function readLastRun() {
  if (!existsSync(PATHS.lastRun)) return null
  try {
    return JSON.parse(readFileSync(PATHS.lastRun, 'utf8'))
  } catch {
    return null
  }
}

function writeLastRun(payload) {
  mkdirSync(PATHS.dir, { recursive: true })
  writeFileSync(PATHS.lastRun, JSON.stringify(payload, null, 2))
}

function sha256File(file) {
  if (!existsSync(file)) return null
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function benchmarkHashes() {
  return { bench: sha256File(PATHS.bench), gate: sha256File(PATHS.gate) }
}

function isExecutable(file) {
  if (!existsSync(file)) return false
  try {
    return (statSync(file).mode & 0o111) !== 0
  } catch {
    return false
  }
}

function budgetFromArgs(raw) {
  const out = { ...DEFAULT_BUDGET }
  if (raw && typeof raw === 'object') {
    for (const key of ['maxTrials', 'maxMinutes', 'maxFailures']) {
      const value = Number(raw[key])
      if (Number.isFinite(value) && value > 0) out[key] = Math.round(value)
    }
  }
  return out
}

function publicState(st) {
  return {
    active: st.active,
    round: st.round,
    goal: st.goal,
    metric: st.metric,
    unit: st.unit,
    direction: st.direction,
    baseline: st.baseline,
    best: st.best,
    best_run: st.bestRun,
    delta_pct: st.deltaPct,
    trials: st.trials.length,
    kept: st.trials.filter((t) => t.decision === 'keep').length,
    confidence: st.confidence,
    plateau: st.plateau,
    doom_loop: st.doomLoop,
    consecutive_failures: st.consecutiveFailures,
    budget: st.budget,
    constraints: st.constraints,
    next: nextHint(st),
  }
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

async function toolOpen(args) {
  const existing = state()
  if (args.resume === true) {
    if (!existing.open) {
      return { ok: false, error: 'no loop session to resume; call loop_open without resume first' }
    }
    return { ok: true, resumed: true, state: publicState(existing) }
  }
  const goal = String(args.goal ?? '').trim()
  const metric = String(args.metric ?? '').trim()
  const direction = args.direction === 'higher' ? 'higher' : 'lower'
  if (!goal) return { ok: false, error: 'goal is required (one line: what are we optimizing?)' }
  if (!metric) return { ok: false, error: 'metric is required (the name printed by `METRIC <name>=<value>`)' }
  if (!isRepo(PATHS.workDir)) {
    return {
      ok: false,
      error: `work dir ${PATHS.workDir} is not a git repository; keep/revert needs git. Run git init there first.`,
    }
  }
  const dirty = isDirty(PATHS.workDir)
  const ignored = ensureIgnored(PATHS.workDir)
  const round = (existing.open?.round ?? 0) + 1
  const constraints = Array.isArray(args.constraints)
    ? args.constraints
        .filter((c) => c && typeof c.metric === 'string' && Number(c.maxPct) > 0)
        .map((c) => ({ metric: c.metric, maxPct: Number(c.maxPct) }))
    : []
  const row = {
    type: 'open',
    round,
    goal,
    metric,
    unit: typeof args.unit === 'string' ? args.unit : '',
    direction,
    constraints,
    budget: budgetFromArgs(args.budget),
    bench_hashes: benchmarkHashes(),
    branch: currentBranch(PATHS.workDir),
    createdAt: new Date().toISOString(),
  }
  appendRow(PATHS.ledger, row)
  writeLastRun(null)
  mkdirSync(PATHS.dir, { recursive: true })
  const brief = [
    `# Loop brief — 第 ${round} 轮`,
    '',
    `- 目标：${goal}`,
    `- 主度量：\`${metric}\`${row.unit ? `（${row.unit}）` : ''}，${direction === 'higher' ? '越大越好' : '越小越好'}`,
    `- 预算：${row.budget.maxTrials} 次试验 / ${row.budget.maxMinutes} 分钟 / 连续失败 ${row.budget.maxFailures} 次即停`,
    constraints.length > 0
      ? `- 次级约束：${constraints.map((c) => `${c.metric} ≤ 基线 ${c.maxPct}%`).join('，')}`
      : '- 次级约束：无',
    row.branch ? `- 分支：${row.branch}` : '- 分支：未命名',
    '',
    '## 已尝试（每轮追加一行）',
    '',
  ].join('\n')
  writeFileSync(PATHS.brief, brief)
  return {
    ok: true,
    round,
    state: publicState(state()),
    gitignore_updated: ignored,
    warning: dirty
      ? 'work tree is dirty; commit or stash unrelated changes first so keep/revert only touches experiment work'
      : null,
    next: 'run the baseline with loop_run (no code change yet), then loop_commit with decision=baseline',
  }
}

async function toolRun(args) {
  const st = state()
  if (!st.open) return { ok: false, error: 'no loop session; call loop_open first' }
  if (!st.active) return { ok: false, error: 'the round is closed; call loop_open to start a new round' }
  const blocked = stopReason(st)
  if (blocked) return { ok: false, error: `cannot run: ${blocked}` }

  const hasBench = existsSync(PATHS.bench)
  const benchRel = relativeBench()
  const command = String(args.command ?? (hasBench ? `bash ${benchRel}` : '')).trim()
  if (!command) return { ok: false, error: 'command is required (or create .zloop/bench.sh)' }
  if (hasBench && !isLockedCommand(command, benchRel)) {
    return {
      ok: false,
      error: `.zloop/bench.sh is frozen: loop_run only executes that script (e.g. "bash .zloop/bench.sh"). The command you gave is not the benchmark.`,
    }
  }

  const current = benchmarkHashes()
  const recorded = st.open.bench_hashes ?? {}
  const drift = []
  for (const key of ['bench', 'gate']) {
    if (recorded[key] && recorded[key] !== current[key]) drift.push(key === 'bench' ? 'bench.sh' : 'gate.sh')
  }

  const repeat = Math.min(Math.max(Number(args.repeat) || 1, 1), 10)
  const timeoutMs =
    Number(args.timeout_seconds) > 0 ? Number(args.timeout_seconds) * 1000 : BENCH_TIMEOUT_MS

  const runs = []
  let last = null
  for (let i = 0; i < repeat; i++) {
    last = await runShell(command, timeoutMs, PATHS.workDir)
    const parsed = parseMetrics(last.output, st.metric)
    runs.push({
      exit_code: last.exitCode,
      timed_out: last.timedOut,
      duration_ms: last.durationMs,
      metric: parsed.primary,
      metrics: parsed.metrics,
    })
  }

  const aggregate = {}
  const names = new Set()
  for (const run of runs) for (const name of Object.keys(run.metrics)) names.add(name)
  for (const name of names) {
    const value = median(runs.map((r) => r.metrics[name]))
    if (value != null) aggregate[name] = value
  }
  const primaryValues = runs.map((r) => r.metric).filter((v) => v != null)
  const metric = primaryValues.length > 0 ? median(primaryValues) : null

  let gate = { ran: false }
  if (existsSync(PATHS.gate) && last?.exitCode === 0) {
    const gateRun = await runShell(`bash ${JSON.stringify(PATHS.gate)}`, GATE_TIMEOUT_MS, PATHS.workDir)
    gate = {
      ran: true,
      failed: gateRun.exitCode !== 0,
      exit_code: gateRun.exitCode,
      duration_ms: gateRun.durationMs,
      output_tail: truncateTail(gateRun.outputTail, 40, 4096),
    }
  }

  writeLastRun({
    ts: new Date().toISOString(),
    command,
    repeat,
    metric,
    metrics: aggregate,
    exit_code: last?.exitCode ?? null,
    timed_out: last?.timedOut ?? false,
    duration_ms: last?.durationMs ?? 0,
    gate_failed: gate.ran === true && gate.failed === true,
  })

  return {
    ok: true,
    repeat,
    runs: repeat > 1 ? runs : undefined,
    metric,
    median_metric: repeat > 1 ? metric : undefined,
    metrics: aggregate,
    exit_code: last?.exitCode ?? null,
    timed_out: last?.timedOut ?? false,
    duration_ms: last?.durationMs ?? 0,
    gate,
    output_tail: truncateTail(last?.outputTail),
    log_file: last?.logFile ?? null,
    ...(drift.length > 0
      ? {
          benchmark_drift: true,
          warning: `${drift.join('/')} changed since the round opened, so numbers are no longer comparable; open a new round or restore the frozen script.`,
        }
      : {}),
    next:
      metric == null
        ? 'the benchmark printed no METRIC line for the primary metric; fix the script or the metric name'
        : 'call loop_commit with the decision (baseline/keep/revert/drop/error)',
  }
}

function relativeBench() {
  return PATHS.bench.startsWith(PATHS.workDir)
    ? PATHS.bench.slice(PATHS.workDir.length + 1).replace(/\\/g, '/')
    : PATHS.bench
}

async function toolCommit(args) {
  const st = state()
  if (!st.open) return { ok: false, error: 'no loop session; call loop_open first' }
  if (!st.active) return { ok: false, error: 'the round is closed; call loop_open to start a new round' }

  const decision = String(args.decision ?? '').trim()
  const note = String(args.note ?? '').trim()
  const lastRun = readLastRun()
  const rawMetric = args.metric != null ? Number(args.metric) : (lastRun?.metric ?? null)
  // An error row records no measurement: the run never produced a number.
  const metric = decision === 'error' ? null : rawMetric
  const metrics = args.metrics && typeof args.metrics === 'object' ? args.metrics : (lastRun?.metrics ?? null)

  if (decision === 'keep' || decision === 'revert' || decision === 'drop') {
    if (!lastRun) {
      return { ok: false, error: 'no benchmark run recorded in this round; call loop_run before deciding' }
    }
  }
  if (decision === 'keep' && lastRun?.gate_failed) {
    return {
      ok: false,
      error: 'the gate script failed on the last run; a failing change cannot be kept. Use decision=drop with the reason.',
    }
  }

  const trial = {
    type: 'trial',
    round: st.round,
    n: st.trials.length + 1,
    decision,
    metric: metric != null && Number.isFinite(metric) ? metric : null,
    metrics: metrics && typeof metrics === 'object' ? metrics : undefined,
    note,
    hypothesis: typeof args.hypothesis === 'string' ? args.hypothesis : undefined,
    expected: typeof args.expected === 'string' ? args.expected : undefined,
    observed: typeof args.observed === 'string' ? args.observed : undefined,
    gate: lastRun?.gate_failed ? 'failed' : existsSync(PATHS.gate) ? 'passed' : 'none',
    duration_ms: lastRun?.duration_ms ?? null,
  }

  const violation = validateTrial(st, trial)[0]
  if (violation) {
    return { ok: false, error: `ledger rejected the trial (${violation.code}): ${violation.message}` }
  }
  if (decision === 'keep') {
    const { violations, results } = checkConstraints(st, metrics ?? lastRun?.metrics ?? {})
    if (violations.length > 0) {
      return { ok: false, error: `ledger rejected the trial (constraint): ${violations[0].message}` }
    }
    if (results.length > 0) trial.constraint_results = results
  }

  let gitAction = 'none'
  let commit = null
  if (decision === 'keep') {
    const body = JSON.stringify({
      round: st.round,
      trial: trial.n,
      metric: trial.metric,
      baseline: st.baseline,
      delta_pct: improvementPct(trial.metric, st.baseline, st.direction),
      note,
    })
    const result = commitAll(PATHS.workDir, `loop: ${note || `trial ${trial.n}`}\n\nResult: ${body}`)
    if (!result.hash) {
      return {
        ok: false,
        error: `keep produced no commit (${result.error}); nothing changed, so there is nothing to retain. Use decision=noop to record a measurement without a change.`,
      }
    }
    commit = result.hash
    trial.commit = commit
    gitAction = 'committed'
  } else if (decision === 'revert' || decision === 'drop' || decision === 'error') {
    const result = rollbackAll(PATHS.workDir)
    if (!result.ok) {
      return { ok: false, error: `rollback failed: ${result.errors.join('; ')}` }
    }
    gitAction = 'rolled back'
  }

  const confidence = judgeConfidence({
    values: [...st.trials, trial].map((t) => t.metric),
    baseline: st.baseline ?? trial.metric,
    best:
      decision === 'keep' && (st.best == null || (st.direction === 'higher' ? trial.metric > st.best : trial.metric < st.best))
        ? trial.metric
        : st.best,
  })
  if (confidence) trial.confidence = confidence
  trial.ts = new Date().toISOString()
  appendRow(PATHS.ledger, trial)
  writeLastRun(null)

  const next = state()
  return {
    ok: true,
    trial: trial.n,
    decision,
    metric: trial.metric,
    baseline: next.baseline,
    best: next.best,
    delta_pct: next.deltaPct,
    confidence: next.confidence,
    git: gitAction,
    commit,
    plateau: next.plateau,
    doom_loop: next.doomLoop,
    next: nextHint(next),
  }
}

async function toolState() {
  const st = state()
  return {
    ok: true,
    session: st.open
      ? { round: st.round, goal: st.goal, active: st.active, opened_at: st.open.createdAt }
      : null,
    state: publicState(st),
    recent: st.trials.slice(-5).map((t) => ({
      n: t.n,
      decision: t.decision,
      metric: t.metric,
      note: t.note,
      commit: t.commit ?? null,
    })),
    git_log: recentLog(PATHS.workDir, 5),
    frozen: {
      bench: existsSync(PATHS.bench),
      gate: existsSync(PATHS.gate),
      bench_executable: isExecutable(PATHS.bench),
    },
  }
}

async function toolReport() {
  const st = state()
  if (!st.open) return { ok: false, error: 'no loop session; nothing to report yet' }
  mkdirSync(PATHS.dir, { recursive: true })
  const html = renderHtml(st)
  const markdown = renderMarkdown(st)
  writeFileSync(PATHS.reportHtml, html)
  writeFileSync(PATHS.reportMd, markdown)
  return {
    ok: true,
    html: PATHS.reportHtml,
    markdown: PATHS.reportMd,
    summary: `${st.trials.length} trials, ${st.trials.filter((t) => t.decision === 'keep').length} kept, ${improvementPct(st.best, st.baseline, st.direction) ?? 0}% improvement`,
    state: publicState(st),
  }
}

async function toolClose(args) {
  const st = state()
  if (!st.open) return { ok: false, error: 'no loop session to close' }
  if (!st.active) return { ok: true, already_closed: true, state: publicState(st) }
  const summary = String(args.summary ?? '').trim()
  appendRow(PATHS.ledger, {
    type: 'close',
    round: st.round,
    summary,
    baseline: st.baseline,
    best: st.best,
    delta_pct: st.deltaPct,
    trials: st.trials.length,
    kept: st.trials.filter((t) => t.decision === 'keep').length,
    ts: new Date().toISOString(),
  })
  mkdirSync(PATHS.dir, { recursive: true })
  appendFileSync(
    PATHS.brief,
    `\n## 收尾（第 ${st.round} 轮）\n\n${summary || '(未填写摘要)'}\n\n基线 ${st.baseline ?? '—'} → 最佳 ${st.best ?? '—'}（${improvementPct(st.best, st.baseline, st.direction) ?? 0}%），共 ${st.trials.length} 次试验，保留 ${st.trials.filter((t) => t.decision === 'keep').length} 次。\n`,
  )
  const next = state()
  return { ok: true, closed: true, summary, state: publicState(next) }
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'loop_open',
    description:
      'Open (or resume) a measurement loop round. Requires the work dir to be a git repo: keep commits, revert/drop roll back. Records the goal, the primary metric name (printed by the benchmark as `METRIC name=value`), direction, budget and optional secondary-metric constraints. Pass resume:true to inspect the current round instead of opening a new one.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'one-line objective, e.g. "cut p95 latency of GET /api/orders"' },
        metric: { type: 'string', description: 'primary metric name, e.g. p95_ms' },
        unit: { type: 'string', description: 'optional unit: ms, s, kb, mb, score' },
        direction: { type: 'string', enum: ['lower', 'higher'], description: 'lower is better (default) or higher' },
        budget: {
          type: 'object',
          description: 'optional caps: maxTrials, maxMinutes, maxFailures',
          properties: {
            maxTrials: { type: 'number' },
            maxMinutes: { type: 'number' },
            maxFailures: { type: 'number' },
          },
        },
        constraints: {
          type: 'array',
          description: 'optional secondary-metric guardrails, e.g. [{metric:"mem_mb",maxPct:105}]',
          items: {
            type: 'object',
            properties: { metric: { type: 'string' }, maxPct: { type: 'number' } },
            required: ['metric', 'maxPct'],
          },
        },
        resume: { type: 'boolean' },
      },
    },
  },
  {
    name: 'loop_run',
    description:
      'Run the benchmark in the work dir: times it, parses `METRIC name=value` lines, optionally repeats (median) and runs .zloop/gate.sh when present. When .zloop/bench.sh exists only that script may run. Returns the metric, secondary metrics, gate outcome and a short output tail.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'shell command (defaults to "bash .zloop/bench.sh" when it exists)' },
        repeat: { type: 'number', description: 'run N times and use the median (1-10, default 1)' },
        timeout_seconds: { type: 'number', description: 'override the benchmark timeout' },
      },
    },
  },
  {
    name: 'loop_commit',
    description:
      'Record the decision for the latest run. keep → git commit (only if the metric beats the best); revert → roll back a measured non-improvement; drop → abandon the idea (e.g. gate failed); error → benchmark crashed; baseline → first trial of the round; noop → record without touching git. The ledger rejects impossible rows (keep that is not better, revert that is better, commit on non-keep).',
    inputSchema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          enum: ['baseline', 'keep', 'revert', 'drop', 'error', 'noop'],
        },
        note: { type: 'string', description: 'one line: what changed and why (required for keep)' },
        metric: { type: 'number', description: 'override; defaults to the last loop_run metric' },
        metrics: { type: 'object', description: 'secondary metrics; defaults to the last run' },
        hypothesis: { type: 'string', description: 'the hypothesis you tested' },
        expected: { type: 'string', description: 'what you expected the metric to do' },
        observed: { type: 'string', description: 'what actually happened (survives the revert)' },
      },
      required: ['decision', 'note'],
    },
  },
  {
    name: 'loop_state',
    description:
      'Snapshot of the open round: goal, metric, direction, baseline, best, delta, budget burn, confidence, plateau/doom-loop flags, recent trials and the git log.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'loop_report',
    description:
      'Write loop-report.html (self-contained dashboard with a sparkline) and loop-report.md (markdown summary for weekly reports) in the work dir and return their paths.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'loop_close',
    description:
      'Close the round with a summary. Kept commits stay on the branch; the ledger keeps the full history.',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'what was learned; goes into the brief' } },
    },
  },
]

const HANDLERS = {
  loop_open: toolOpen,
  loop_run: toolRun,
  loop_commit: toolCommit,
  loop_state: toolState,
  loop_report: toolReport,
  loop_close: toolClose,
}

process.on('uncaughtException', (error) => {
  log('uncaught:', error?.stack || String(error))
})
process.on('unhandledRejection', (error) => {
  log('unhandled rejection:', error?.stack || String(error))
})
