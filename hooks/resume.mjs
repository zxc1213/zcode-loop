#!/usr/bin/env node
/**
 * SessionStart hook: point the agent at an open round so a fresh session can
 * pick the loop back up instead of starting over.
 */
import { readProjectConfig } from '../lib/paths.mjs'
import { loopPaths } from '../lib/paths.mjs'
import { rebuildState } from '../lib/ledger.mjs'

const PROJECT_DIR = process.argv[2] || process.env.ZCODE_PROJECT_DIR || process.cwd()

try {
  const cfg = readProjectConfig(PROJECT_DIR)
  if (cfg.autoContinue === false) process.exit(0)
  const state = rebuildState(PROJECT_DIR, loopPaths(PROJECT_DIR))
  if (!state.open || !state.active) process.exit(0)
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          `[zcode-loop] 本工作区有进行中的第 ${state.round} 轮实验（${state.metric}，` +
          `${state.trials.length}/${state.budget.maxTrials} 次试验，best=${state.best ?? '—'}）。` +
          `用 /zcode-loop:loop-status 查看，或 loop_state 后继续 loop_run → loop_commit。`,
      },
    }),
  )
} catch {
  process.exit(0)
}
