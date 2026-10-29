/**
 * Append-only ledger and the state derived from it.
 *
 * One JSON object per line. `open` rows start a round, `trial` rows record one
 * decision, `close` rows end the round. Rebuilding is a pure fold over the file,
 * so a crash mid-loop never corrupts the history.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { loopPaths, readProjectConfig } from './paths.mjs'
import {
  detectDoomLoop,
  detectPlateau,
  improvementPct,
  isBetter,
  judgeConfidence,
} from './stats.mjs'

export const DEFAULT_BUDGET = {
  maxTrials: 20,
  maxMinutes: 120,
  maxFailures: 3,
}

export function readLedger(file) {
  if (!existsSync(file)) return []
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      const row = JSON.parse(text)
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row)
    } catch {
      // A torn final line is expected after a hard kill; skip it.
    }
  }
  return rows
}

export function appendRow(file, row) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(row) + '\n')
}

export function budgetFor(projectDir, openRow) {
  const cfg = readProjectConfig(projectDir)
  const fromConfig = cfg && typeof cfg === 'object' ? cfg : {}
  const pick = (key, fallback) => {
    const v = Number(fromConfig[key])
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  return {
    maxTrials: Number(openRow?.budget?.maxTrials) || pick('maxTrials', DEFAULT_BUDGET.maxTrials),
    maxMinutes: Number(openRow?.budget?.maxMinutes) || pick('maxMinutes', DEFAULT_BUDGET.maxMinutes),
    maxFailures:
      Number(openRow?.budget?.maxFailures) || pick('maxFailures', DEFAULT_BUDGET.maxFailures),
  }
}

export function rebuildState(projectDir, paths = loopPaths(projectDir)) {
  const rows = readLedger(paths.ledger)
  const opens = rows.filter((r) => r.type === 'open')
  const open = opens.length > 0 ? opens[opens.length - 1] : null
  const closedRow = [...rows].reverse().find((r) => r.type === 'close' && r.round === open?.round)
  const round = open?.round ?? 0
  const allTrials = rows.filter((r) => r.type === 'trial')
  const trials = allTrials.filter((r) => r.round === round)
  const direction = open?.direction === 'higher' ? 'higher' : 'lower'

  const scored = trials.filter((t) => typeof t.metric === 'number' && Number.isFinite(t.metric))
  const baseline = scored.length > 0 ? scored[0].metric : null
  let best = baseline
  let bestRun = scored.length > 0 ? scored[0].n : null
  for (const t of trials) {
    if (t.decision !== 'keep') continue
    if (t.metric == null || !Number.isFinite(t.metric)) continue
    if (best == null || isBetter(t.metric, best, direction)) {
      best = t.metric
      bestRun = t.n
    }
  }

  let consecutiveFailures = 0
  for (const t of [...trials].reverse()) {
    if (t.decision === 'error' || t.decision === 'drop') consecutiveFailures += 1
    else break
  }

  const lastScored = scored.length > 0 ? scored[scored.length - 1] : null
  const confidence = judgeConfidence({
    values: scored.map((t) => t.metric),
    baseline,
    best,
  })

  const budget = budgetFor(projectDir, open)
  const openedAt = open?.createdAt ? Date.parse(open.createdAt) : null
  const lastTs = trials.length > 0 ? Date.parse(trials[trials.length - 1].ts) : openedAt
  const reference = Number.isFinite(lastTs) ? lastTs : Date.now()
  const elapsedMinutes = Number.isFinite(openedAt)
    ? Math.max(0, Math.round((reference - openedAt) / 60000))
    : 0

  return {
    paths,
    rows,
    round,
    open,
    active: Boolean(open) && !closedRow,
    closedRow: closedRow ?? null,
    goal: open?.goal ?? '',
    metric: open?.metric ?? '',
    unit: open?.unit ?? '',
    direction,
    constraints: Array.isArray(open?.constraints) ? open.constraints : [],
    trials,
    baseline,
    best,
    bestRun,
    lastScored,
    lastMetric: lastScored?.metric ?? null,
    deltaPct: improvementPct(best, baseline, direction),
    confidence,
    consecutiveFailures,
    plateau: detectPlateau(trials),
    doomLoop: detectDoomLoop(trials),
    budget: {
      ...budget,
      used: trials.length,
      remaining: Math.max(0, budget.maxTrials - trials.length),
      elapsedMinutes,
      minutesRemaining: Math.max(0, budget.maxMinutes - elapsedMinutes),
    },
  }
}

/** True when the loop must not start another trial. */
export function stopReason(state) {
  if (!state.open) return 'no session'
  if (!state.active) return 'session closed'
  if (state.budget.used >= state.budget.maxTrials) return `trial budget reached (${state.budget.maxTrials})`
  if (state.budget.elapsedMinutes >= state.budget.maxMinutes)
    return `time budget reached (${state.budget.maxMinutes} min)`
  if (state.consecutiveFailures >= state.budget.maxFailures)
    return `consecutive failures reached (${state.consecutiveFailures}/${state.budget.maxFailures})`
  return null
}

export function nextHint(state) {
  const stop = stopReason(state)
  if (stop) return `loop should stop: ${stop}. summarize and close the round.`
  if (state.plateau) return 'plateau: last 5 trials moved < 1%; confirm with a repeated measurement, open a new round, or close.'
  if (state.doomLoop) return `doom loop (${state.doomLoop.pattern}): stop repeating the same hypothesis and pick a structurally different one.`
  if (state.trials.length === 0) return 'run the baseline trial first (decision=baseline).'
  return 'pick the next hypothesis, change one thing, run the benchmark, then commit the decision.'
}
