/**
 * Ledger invariants. A trial that breaks them is rejected before any git
 * operation runs, so the history can always be trusted as evidence.
 */
import { isBetter } from './stats.mjs'

export const DECISIONS = ['baseline', 'keep', 'revert', 'drop', 'error', 'noop']

export function validateTrial(state, trial) {
  const violations = []
  const push = (code, message) => violations.push({ code, message })

  if (!DECISIONS.includes(trial.decision)) {
    push('decision', `unknown decision "${trial.decision}" (expected ${DECISIONS.join('/')})`)
    return violations
  }
  if (trial.n !== state.trials.length + 1) {
    push('numbering', `trial number ${trial.n} does not follow the ledger (${state.trials.length} recorded)`)
  }
  if (trial.round !== state.round) {
    push('round', `trial round ${trial.round} does not match the open round ${state.round}`)
  }
  if (trial.commit) {
    push('commit_field', 'commit is filled in by the tool; do not pass it')
  }
  const metricFinite = typeof trial.metric === 'number' && Number.isFinite(trial.metric)

  if (trial.decision === 'baseline') {
    if (state.trials.length > 0) push('baseline_order', 'baseline is only valid as the first trial of a round')
    if (!metricFinite) push('baseline_metric', 'baseline needs a finite metric')
  }
  if (trial.decision === 'keep') {
    if (!metricFinite) push('keep_metric', 'keep needs a finite metric')
    if (state.trials.length === 0) push('keep_first', 'the first trial is the baseline, not a keep')
    if (!String(trial.note || '').trim()) push('keep_note', 'keep needs a one-line note describing the change')
    if (metricFinite && state.best != null && !isBetter(trial.metric, state.best, state.direction)) {
      push(
        'keep_not_better',
        `metric ${trial.metric} does not beat the current best ${state.best} (direction=${state.direction}); use revert instead`,
      )
    }
  }
  if (trial.decision === 'revert' && metricFinite && state.best != null) {
    if (isBetter(trial.metric, state.best, state.direction)) {
      push('revert_better', `metric ${trial.metric} beats best ${state.best}; a real improvement must be kept (or dropped with a reason)`)
    }
  }
  if (trial.decision === 'error' && metricFinite) {
    push('error_metric', 'an error trial records no metric (null); use revert for a measured non-improvement')
  }
  return violations
}

export function checkConstraints(state, metrics) {
  const results = []
  const violations = []
  for (const constraint of state.constraints) {
    const name = constraint?.metric
    const maxPct = Number(constraint?.maxPct)
    if (!name || !Number.isFinite(maxPct) || maxPct <= 0) continue
    const value = metrics?.[name]
    const base = state.trials[0]?.metrics?.[name]
    if (!Number.isFinite(value) || !Number.isFinite(base)) {
      results.push({ metric: name, status: 'skipped', reason: 'no baseline or value' })
      continue
    }
    const limit = (base * maxPct) / 100
    const pass = value <= limit
    results.push({ metric: name, status: pass ? 'pass' : 'fail', value, base, limit })
    if (!pass) {
      violations.push({
        code: 'constraint',
        message: `${name}=${value} exceeds ${maxPct}% of baseline ${base} (limit ${Number(limit.toFixed(3))}); use revert or drop`,
      })
    }
  }
  return { results, violations }
}
