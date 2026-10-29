#!/usr/bin/env node
/**
 * Stop hook: keep an unfinished round moving. ZCode allows a few consecutive
 * Stop continuations per window, so this only blocks when the ledger says there
 * is budget left, nothing is stalled, and the user has not switched it off.
 */
import { loopPaths, readProjectConfig } from '../lib/paths.mjs'
import { rebuildState, stopReason } from '../lib/ledger.mjs'

const PROJECT_DIR = process.argv[2] || process.env.ZCODE_PROJECT_DIR || process.cwd()

async function readStdin() {
  let raw = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) raw += chunk
  return raw
}

try {
  await readStdin()
  const cfg = readProjectConfig(PROJECT_DIR)
  if (cfg.autoContinue === false) process.exit(0)

  const paths = loopPaths(PROJECT_DIR)
  const state = rebuildState(PROJECT_DIR, paths)
  if (!state.open || !state.active || state.trials.length === 0) process.exit(0)
  if (stopReason(state)) process.exit(0)

  if (state.plateau) {
    process.stderr.write(
      `[zcode-loop] 第 ${state.round} 轮进入平台期（最近 5 轮改善 < 1%，best=${state.best ?? '—'}）：建议复测确认或 loop_close 收尾。\n`,
    )
    process.exit(0)
  }
  if (state.doomLoop) {
    process.stderr.write(
      `[zcode-loop] 检测到重复尝试（${state.doomLoop.label}）：换结构性不同的假设。\n`,
    )
  }

  const tail = state.trials
    .slice(-3)
    .map((t) => `#${t.n} ${t.decision} metric=${t.metric ?? '—'} ${String(t.note || '').slice(0, 80)}`)
    .join('\n')
  const reason =
    `[zcode-loop] 第 ${state.round} 轮未结束：已跑 ${state.trials.length}/${state.budget.maxTrials}，` +
    `baseline=${state.baseline ?? '—'}，best=${state.best ?? '—'}（${state.deltaPct ?? 0}%）。\n${tail}\n` +
    `继续：选下一个假设 → 只改一处 → loop_run → loop_commit。若已收敛请 loop_close 收尾；` +
    `需要暂停就在 .zloop/config.json 设 autoContinue:false。`

  process.stdout.write(JSON.stringify({ decision: 'block', reason }))
} catch {
  process.exit(0)
}
