/**
 * Pure measurement helpers: metric parsing, robust statistics and the two
 * stall detectors (plateau / repeated hypothesis).
 *
 * A benchmark reports numbers on lines shaped `METRIC name=value`; everything
 * else it prints is ignored for scoring but still shown to the agent as a tail.
 */

const METRIC_LINE = /^METRIC\s+([A-Za-z0-9_.:-]+)\s*=\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*$/

export function parseMetrics(text, primaryName) {
  const metrics = {}
  let primary = null
  if (typeof text !== 'string' || !text) return { metrics, primary }
  for (const raw of text.split('\n')) {
    const m = METRIC_LINE.exec(raw.trim())
    if (!m) continue
    const value = Number(m[2])
    if (!Number.isFinite(value)) continue
    // Last writer wins: a benchmark that prints a metric twice means the
    // second line is the settled number (progress counters do this).
    metrics[m[1]] = value
    if (m[1] === primaryName) primary = value
  }
  if (primary == null && primaryName && Object.keys(metrics).length === 0) {
    return { metrics, primary: null }
  }
  return { metrics, primary }
}

export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

export function mean(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x))
  if (v.length === 0) return null
  return v.reduce((a, b) => a + b, 0) / v.length
}

/** Median absolute deviation around the sample median. */
export function mad(values) {
  const center = median(values)
  if (center == null) return null
  return median(values.map((v) => Math.abs(v - center)))
}

/**
 * Is the improvement big enough to trust? Compares the signal (baseline → best)
 * with the noise floor measured from every sample in the round.
 *
 * level: high (signal >= 3x noise), medium (>= 1x), low (below noise).
 */
export function judgeConfidence({ values, baseline, best }) {
  const finite = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (finite.length === 0) return null
  const noise = mad(finite) ?? 0
  const scale = Math.max(Math.abs(median(finite) ?? 0), 1e-9)
  const noisePct = noise / scale
  let signalPct = 0
  if (baseline != null && best != null) {
    signalPct = Math.abs(best - baseline) / Math.max(Math.abs(baseline), 1e-9)
  }
  const ratio = signalPct === 0 ? 0 : signalPct / Math.max(noisePct, 1e-9)
  const level = ratio >= 3 ? 'high' : ratio >= 1 ? 'medium' : 'low'
  return {
    level,
    ratio: Number(ratio.toFixed(3)),
    noisePct: Number((noisePct * 100).toFixed(3)),
    signalPct: Number((signalPct * 100).toFixed(3)),
  }
}

export function isBetter(candidate, reference, direction) {
  if (candidate == null || reference == null) return false
  return direction === 'higher' ? candidate > reference : candidate < reference
}

/**
 * Accept the frozen benchmark in its common spellings and reject anything else,
 * so a locked benchmark cannot be swapped for `curl ... | sh`.
 */
export function isLockedCommand(command, script = '.zloop/bench.sh') {
  const bare = String(command)
    .trim()
    .replace(/^(?:time|exec)\s+/g, '')
    .replace(/^env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/g, '')
    .replace(/^nice(?:\s+-n\s+-?\d+)?\s+/g, '')
    .trim()
  const scriptName = script.replace(/^\.\//, '')
  const base = scriptName.split('/').pop()
  const accepted = [
    scriptName,
    `./${scriptName}`,
    `bash ${scriptName}`,
    `bash ./${scriptName}`,
    `sh ${scriptName}`,
    `sh ./${scriptName}`,
    `bash -e ${scriptName}`,
    `bash -e ./${scriptName}`,
    base,
    `./${base}`,
    `bash ${base}`,
    `bash ./${base}`,
    `sh ${base}`,
    `sh ./${base}`,
  ]
  return accepted.includes(bare)
}

/** Last `window` scored trials moved less than `threshold` (relative). */
export function detectPlateau(trials, window = 5, threshold = 0.01) {
  const scored = trials.filter((t) => typeof t.metric === 'number' && Number.isFinite(t.metric))
  if (scored.length < window) return false
  const tail = scored.slice(-window)
  const first = tail[0].metric
  const last = tail[tail.length - 1].metric
  if (Math.abs(first) < 1e-12) return false
  return Math.abs(last - first) / Math.abs(first) < threshold
}

export function normalizeHypothesis(text) {
  if (typeof text !== 'string') return null
  const normalized = text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 120)
  return normalized || null
}

export function hypothesesSimilar(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  return short.length >= 12 && long.includes(short) && short.length / long.length >= 0.6
}

/**
 * Two failure shapes worth interrupting the agent for:
 *  - repeat: the same hypothesis (or a near-duplicate) three times in the tail
 *  - oscillate: A → B → A → B across the last four scored trials
 */
export function detectDoomLoop(trials, tail = 6) {
  const labels = trials
    .slice(-tail)
    .map((t) => normalizeHypothesis(t.hypothesis || t.note || ''))
    .filter(Boolean)
  const clusters = []
  for (const label of labels) {
    const cluster = clusters.find((c) => hypothesesSimilar(c[0], label))
    if (cluster) cluster.push(label)
    else clusters.push([label])
  }
  const repeated = clusters.find((c) => c.length >= 3)
  if (repeated) return { pattern: 'repeat', label: repeated[0] }
  if (labels.length >= 4) {
    const [a, b, c, d] = labels.slice(-4)
    if (a === c && b === d && !hypothesesSimilar(a, b)) return { pattern: 'oscillate', label: a }
  }
  return null
}

/** Percent change from baseline; positive always means "better". */
export function improvementPct(value, baseline, direction) {
  if (value == null || baseline == null) return null
  if (Math.abs(baseline) < 1e-12) return null
  const raw = ((value - baseline) / Math.abs(baseline)) * 100
  return Number((direction === 'higher' ? raw : -raw).toFixed(3))
}

export function truncateTail(text, maxLines = 12, maxBytes = 4096) {
  if (text == null) return ''
  let out = String(text).split('\n').slice(-maxLines).join('\n')
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = Buffer.from(out, 'utf8').subarray(0, maxBytes).toString('utf8')
  }
  return out
}
