import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loopPaths } from '../lib/paths.mjs'
import { appendRow, rebuildState, stopReason, nextHint } from '../lib/ledger.mjs'

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'zloop-ledger-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('rebuildState folds open + trials into baseline/best/budget', () => {
  withTempDir((dir) => {
    const paths = loopPaths(dir)
    appendRow(paths.ledger, {
      type: 'open',
      round: 1,
      goal: 'faster build',
      metric: 'seconds',
      direction: 'lower',
      budget: { maxTrials: 5, maxMinutes: 60, maxFailures: 2 },
      createdAt: new Date().toISOString(),
    })
    appendRow(paths.ledger, { type: 'trial', round: 1, n: 1, decision: 'baseline', metric: 100, ts: new Date().toISOString() })
    appendRow(paths.ledger, { type: 'trial', round: 1, n: 2, decision: 'keep', metric: 80, commit: 'abc1234', ts: new Date().toISOString() })
    appendRow(paths.ledger, { type: 'trial', round: 1, n: 3, decision: 'revert', metric: 85, ts: new Date().toISOString() })

    const state = rebuildState(dir, paths)
    assert.equal(state.active, true)
    assert.equal(state.round, 1)
    assert.equal(state.trials.length, 3)
    assert.equal(state.baseline, 100)
    assert.equal(state.best, 80)
    assert.equal(state.bestRun, 2)
    assert.equal(state.deltaPct, 20)
    assert.equal(state.budget.used, 3)
    assert.equal(state.budget.remaining, 2)
    assert.equal(stopReason(state), null)
    assert.match(nextHint(state), /next hypothesis/)
  })
})

test('close stops the loop and consecutive failures count error/drop only', () => {
  withTempDir((dir) => {
    const paths = loopPaths(dir)
    appendRow(paths.ledger, {
      type: 'open',
      round: 1,
      goal: 'g',
      metric: 'm',
      direction: 'higher',
      budget: { maxTrials: 10, maxMinutes: 60, maxFailures: 2 },
      createdAt: new Date().toISOString(),
    })
    appendRow(paths.ledger, { type: 'trial', round: 1, n: 1, decision: 'baseline', metric: 10, ts: new Date().toISOString() })
    appendRow(paths.ledger, { type: 'trial', round: 1, n: 2, decision: 'revert', metric: 9, ts: new Date().toISOString() })
    appendRow(paths.ledger, { type: 'trial', round: 1, n: 3, decision: 'drop', metric: null, ts: new Date().toISOString() })
    appendRow(paths.ledger, { type: 'trial', round: 1, n: 4, decision: 'error', metric: null, ts: new Date().toISOString() })

    const state = rebuildState(dir, paths)
    assert.equal(state.consecutiveFailures, 2)
    assert.match(stopReason(state), /consecutive failures/)
    assert.equal(state.best, 10)
    assert.equal(state.active, true)

    appendRow(paths.ledger, { type: 'close', round: 1, summary: 'done', ts: new Date().toISOString() })
    const closed = rebuildState(dir, paths)
    assert.equal(closed.active, false)
    assert.match(stopReason(closed), /closed/)
  })
})

test('trials from an older round do not leak into the new one', () => {
  withTempDir((dir) => {
    const paths = loopPaths(dir)
    const ts = new Date().toISOString()
    appendRow(paths.ledger, { type: 'open', round: 1, goal: 'a', metric: 'm', direction: 'lower', budget: {}, createdAt: ts })
    appendRow(paths.ledger, { type: 'trial', round: 1, n: 1, decision: 'baseline', metric: 50, ts })
    appendRow(paths.ledger, { type: 'close', round: 1, summary: 'x', ts })
    appendRow(paths.ledger, { type: 'open', round: 2, goal: 'b', metric: 'm', direction: 'higher', budget: {}, createdAt: ts })
    appendRow(paths.ledger, { type: 'trial', round: 2, n: 1, decision: 'baseline', metric: 5, ts })

    const state = rebuildState(dir, paths)
    assert.equal(state.round, 2)
    assert.equal(state.trials.length, 1)
    assert.equal(state.baseline, 5)
    assert.equal(state.direction, 'higher')
    assert.equal(state.active, true)
  })
})
