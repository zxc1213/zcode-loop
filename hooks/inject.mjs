#!/usr/bin/env node
/**
 * UserPromptSubmit hook: inject a compact ledger summary so the loop survives
 * compaction and long sessions without re-reading files.
 */
import { loopPaths } from '../lib/paths.mjs'
import { rebuildState } from '../lib/ledger.mjs'
import { detectDoomLoop, normalizeHypothesis, hypothesesSimilar } from '../lib/stats.mjs'

const PROJECT_DIR = process.argv[2] || process.env.ZCODE_PROJECT_DIR || process.cwd()

async function readStdin() {
  let raw = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) raw += chunk
  return raw
}

try {
  await readStdin()
  const paths = loopPaths(PROJECT_DIR)
  const state = rebuildState(PROJECT_DIR, paths)
  if (!state.open || !state.active || state.trials.length === 0) process.exit(0)

  const lines = []
  lines.push(
    `[zcode-loop] 第 ${state.round} 轮「${state.goal}」metric=${state.metric} direction=${state.direction}，` +
      `已跑 ${state.trials.length}/${state.budget.maxTrials}，baseline=${state.baseline ?? '—'}，best=${state.best ?? '—'}，改善 ${state.deltaPct ?? 0}%。`,
  )

  const tried = []
  const seen = []
  for (const trial of state.trials) {
    const label = String(trial.hypothesis || trial.note || '').trim()
    if (!label) continue
    const normalized = normalizeHypothesis(label)
    if (normalized && seen.some((s) => hypothesesSimilar(s, normalized))) continue
    if (normalized) seen.push(normalized)
    tried.push(label)
  }
  if (tried.length > 0) lines.push(`已尝试：${tried.slice(-6).join('；')}`)

  const discards = state.trials
    .filter((t) => (t.decision === 'drop' || t.decision === 'revert') && (t.observed || t.note))
    .map((t) => `#${t.n} ${String(t.observed || t.note).slice(0, 60)}`)
    .slice(-6)
  if (discards.length > 0) lines.push(`弃用与理由：${discards.join('；')}`)

  const recent = state.trials
    .slice(-3)
    .map((t) => `#${t.n} ${t.decision} metric=${t.metric ?? '—'} ${String(t.note || '').slice(0, 60)}`)
    .join('\n')
  lines.push(`最近：\n${recent}`)

  const doom = state.doomLoop ?? detectDoomLoop(state.trials)
  if (doom) {
    lines.push(
      doom.pattern === 'oscillate'
        ? '⚠️ 检测到 A→B→A→B 震荡：停止在两个方向间来回，换结构性不同的假设。'
        : '⚠️ 连续重复同一假设：换一个方向。',
    )
  }
  if (state.plateau) lines.push('⚠️ 平台期：最近 5 轮改善 < 1%，考虑复测、换轮次或收尾。')
  if (state.consecutiveFailures >= state.budget.maxFailures) lines.push('⚠️ 连续失败已达上限，应收尾。')

  lines.push('继续循环：改一处 → loop_run → loop_commit（keep/revert/drop）。')

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: lines.join('\n'),
      },
    }),
  )
} catch {
  process.exit(0)
}
