import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateTrial, checkConstraints, DECISIONS } from '../lib/audit.mjs'

function state(overrides = {}) {
  return {
    round: 1,
    direction: 'lower',
    best: null,
    trials: [],
    constraints: [],
    ...overrides,
  }
}

const codes = (violations) => violations.map((v) => v.code)

test('a baseline opens the round and nothing else may call itself baseline', () => {
  assert.deepEqual(validateTrial(state(), { round: 1, n: 1, decision: 'baseline', metric: 10 }), [])
  const later = state({ trials: [{ n: 1 }] })
  assert.ok(codes(validateTrial(later, { round: 1, n: 2, decision: 'baseline', metric: 10 })).includes('baseline_order'))
})

test('keep must beat the best', () => {
  const s = state({ trials: [{ n: 1, metric: 100 }], best: 100 })
  assert.deepEqual(
    validateTrial(s, { round: 1, n: 2, decision: 'keep', metric: 90, note: 'cache' }),
    [],
  )
  assert.ok(
    codes(validateTrial(s, { round: 1, n: 2, decision: 'keep', metric: 110, note: 'cache' })).includes(
      'keep_not_better',
    ),
  )
})

test('revert of a better metric is rejected', () => {
  const s = state({ trials: [{ n: 1, metric: 100 }], best: 100 })
  assert.ok(
    codes(validateTrial(s, { round: 1, n: 2, decision: 'revert', metric: 90 })).includes('revert_better'),
  )
})

test('error rows carry no metric and callers cannot supply commits', () => {
  const s = state({ trials: [{ n: 1, metric: 100 }], best: 100 })
  assert.ok(
    codes(validateTrial(s, { round: 1, n: 2, decision: 'error', metric: 3 })).includes('error_metric'),
  )
  assert.ok(
    codes(validateTrial(s, { round: 1, n: 2, decision: 'revert', metric: 120, commit: 'abc' })).includes(
      'commit_field',
    ),
  )
})

test('numbering and round must match the ledger', () => {
  const s = state({ trials: [{ n: 1, metric: 100 }, { n: 2, metric: 99 }], best: 99 })
  const violations = codes(validateTrial(s, { round: 9, n: 7, decision: 'noop' }))
  assert.ok(violations.includes('numbering'))
  assert.ok(violations.includes('round'))
})

test('keep needs a note; every decision name is known', () => {
  const s = state({ trials: [{ n: 1, metric: 100 }], best: 100 })
  assert.ok(codes(validateTrial(s, { round: 1, n: 2, decision: 'keep', metric: 90 })).includes('keep_note'))
  assert.ok(codes(validateTrial(s, { round: 1, n: 2, decision: 'maybe', metric: 90 })).includes('decision'))
  assert.deepEqual(DECISIONS, ['baseline', 'keep', 'revert', 'drop', 'error', 'noop'])
})

test('constraints compare secondary metrics against the baseline trial', () => {
  const s = state({
    trials: [{ n: 1, metric: 100, metrics: { mem: 200, cpu: 10 } }],
    best: 100,
    constraints: [
      { metric: 'mem', maxPct: 105 },
      { metric: 'cpu', maxPct: 120 },
      { metric: 'missing', maxPct: 100 },
    ],
  })
  const failing = checkConstraints(s, { mem: 300, cpu: 11 })
  assert.equal(failing.violations.length, 1)
  assert.match(failing.violations[0].message, /mem=300/)
  assert.ok(failing.results.some((r) => r.status === 'skipped'))

  const passing = checkConstraints(s, { mem: 205, cpu: 11 })
  assert.equal(passing.violations.length, 0)
})
