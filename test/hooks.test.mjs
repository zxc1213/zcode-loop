import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loopPaths } from '../lib/paths.mjs'
import { appendRow } from '../lib/ledger.mjs'

const HERE = resolve(import.meta.dirname, '..')

function runHook(script, projectDir, payload = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(HERE, 'hooks', script), projectDir], {
      cwd: HERE,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
    child.stdin.end(JSON.stringify(payload))
  })
}

function withLoop(fn, { close = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zloop-hook-'))
  const paths = loopPaths(dir)
  const ts = new Date().toISOString()
  appendRow(paths.ledger, {
    type: 'open',
    round: 1,
    goal: 'trim the bundle',
    metric: 'bundle_kb',
    direction: 'lower',
    budget: { maxTrials: 4, maxMinutes: 60, maxFailures: 2 },
    createdAt: ts,
  })
  appendRow(paths.ledger, { type: 'trial', round: 1, n: 1, decision: 'baseline', metric: 500, ts })
  appendRow(paths.ledger, {
    type: 'trial',
    round: 1,
    n: 2,
    decision: 'keep',
    metric: 480,
    note: 'drop polyfills',
    hypothesis: 'drop polyfills',
    commit: 'abc1234',
    ts,
  })
  if (close) appendRow(paths.ledger, { type: 'close', round: 1, summary: 'done', ts })
  mkdirSync(join(dir, '.zloop'), { recursive: true })
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('guard denies writes to the frozen benchmark and ledger', async () => {
  await withLoop(async (dir) => {
    for (const file of ['bench.sh', 'gate.sh', 'ledger.jsonl']) {
      const out = await runHook('guard.mjs', dir, {
        tool_input: { file_path: join(dir, '.zloop', file) },
      })
      const payload = JSON.parse(out.stdout)
      assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny', file)
    }
    const allowed = await runHook('guard.mjs', dir, {
      tool_input: { file_path: join(dir, 'src', 'index.js') },
    })
    assert.equal(allowed.stdout.trim(), '')
  })
})

test('inject summarises the open round for the model', async () => {
  await withLoop(async (dir) => {
    const out = await runHook('inject.mjs', dir, {})
    const payload = JSON.parse(out.stdout)
    assert.equal(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
    const context = payload.hookSpecificOutput.additionalContext
    assert.match(context, /trim the bundle/)
    assert.match(context, /bundle_kb/)
    assert.match(context, /已尝试：drop polyfills/)
    assert.match(context, /继续循环/)
  })
})

test('inject stays silent when the round is closed', async () => {
  await withLoop(
    async (dir) => {
      const out = await runHook('inject.mjs', dir, {})
      assert.equal(out.stdout.trim(), '')
    },
    { close: true },
  )
})

test('stop hook keeps an unfinished round going', async () => {
  await withLoop(async (dir) => {
    const out = await runHook('continue.mjs', dir, {})
    const payload = JSON.parse(out.stdout)
    assert.equal(payload.decision, 'block')
    assert.match(payload.reason, /第 1 轮未结束/)
  })
})

test('stop hook yields when autoContinue is off', async () => {
  await withLoop(async (dir) => {
    writeFileSync(join(dir, '.zloop', 'config.json'), JSON.stringify({ autoContinue: false }))
    const out = await runHook('continue.mjs', dir, {})
    assert.equal(out.stdout.trim(), '')
  })
})

test('session start points at the open round', async () => {
  await withLoop(async (dir) => {
    const out = await runHook('resume.mjs', dir, {})
    const payload = JSON.parse(out.stdout)
    assert.match(payload.hookSpecificOutput.additionalContext, /第 1 轮实验/)
  })
})

test('hooks fail open on garbage input or no session', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'zloop-empty-'))
  try {
    for (const script of ['guard.mjs', 'inject.mjs', 'continue.mjs', 'resume.mjs']) {
      const out = await runHook(script, empty, {})
      assert.equal(out.code, 0, script)
      assert.equal(out.stdout.trim(), '', script)
    }
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
