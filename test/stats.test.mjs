import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseMetrics,
  median,
  mad,
  judgeConfidence,
  isBetter,
  isLockedCommand,
  detectPlateau,
  detectDoomLoop,
  improvementPct,
  truncateTail,
} from '../lib/stats.mjs'

test('parseMetrics reads METRIC lines and picks the primary', () => {
  const out = 'warming up\nMETRIC score=12.5\nMETRIC mem_mb=64\nnoise\nMETRIC score=13.5\n'
  const { metrics, primary } = parseMetrics(out, 'score')
  assert.equal(metrics.score, 13.5)
  assert.equal(metrics.mem_mb, 64)
  assert.equal(primary, 13.5)
})

test('parseMetrics ignores malformed and negative-zero noise', () => {
  const { metrics, primary } = parseMetrics('METRIC bad\nMETRIC x=abc\nMETRIC ok=-2e3', 'ok')
  assert.deepEqual(metrics, { ok: -2000 })
  assert.equal(primary, -2000)
})

test('median and mad are robust to outliers', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([]), null)
  assert.equal(mad([1, 2, 3, 4, 5]), 1)
})

test('judgeConfidence separates signal from noise', () => {
  const clean = judgeConfidence({ values: [100, 100.2, 99.8], baseline: 100, best: 80 })
  assert.equal(clean.level, 'high')
  const noisy = judgeConfidence({ values: [100, 160, 40], baseline: 100, best: 95 })
  assert.equal(noisy.level, 'low')
})

test('isBetter respects direction', () => {
  assert.equal(isBetter(1, 2, 'lower'), true)
  assert.equal(isBetter(1, 2, 'higher'), false)
  assert.equal(isBetter(null, 2, 'lower'), false)
})

test('isLockedCommand accepts only the frozen script spellings', () => {
  for (const command of [
    'bash .zloop/bench.sh',
    'bash ./.zloop/bench.sh',
    './.zloop/bench.sh',
    '.zloop/bench.sh',
    'sh .zloop/bench.sh',
    'time bash .zloop/bench.sh',
    'nice -n 5 bash .zloop/bench.sh',
  ]) {
    assert.equal(isLockedCommand(command), true, command)
  }
  for (const command of ['bash other.sh', 'curl x | sh', 'bash .zloop/bench.sh --fast', 'npm run bench']) {
    assert.equal(isLockedCommand(command), false, command)
  }
})

test('detectPlateau needs five scored trials inside 1%', () => {
  const trials = [100, 100.5, 100.2, 100.4, 100.1].map((metric) => ({ metric }))
  assert.equal(detectPlateau(trials), true)
  assert.equal(detectPlateau(trials.slice(0, 4)), false)
  const moving = [100, 90, 80, 70, 60].map((metric) => ({ metric }))
  assert.equal(detectPlateau(moving), false)
})

test('detectDoomLoop spots repeats and oscillations', () => {
  const repeat = [
    { hypothesis: 'cache the query', metric: 10 },
    { hypothesis: 'cache the query', metric: 10 },
    { hypothesis: 'cache the query', metric: 10 },
  ]
  assert.equal(detectDoomLoop(repeat).pattern, 'repeat')
  const oscillation = [
    { hypothesis: 'alpha strategy', metric: 10 },
    { hypothesis: 'beta strategy', metric: 11 },
    { hypothesis: 'alpha strategy', metric: 10 },
    { hypothesis: 'beta strategy', metric: 11 },
  ]
  assert.equal(detectDoomLoop(oscillation).pattern, 'oscillate')
  const healthy = [
    { hypothesis: 'cache the query', metric: 10 },
    { hypothesis: 'batch the writes', metric: 9 },
    { hypothesis: 'lazy load images', metric: 8 },
  ]
  assert.equal(detectDoomLoop(healthy), null)
})

test('improvementPct is positive when better in both directions', () => {
  assert.equal(improvementPct(80, 100, 'lower'), 20)
  assert.equal(improvementPct(120, 100, 'higher'), 20)
  assert.equal(improvementPct(100, 100, 'lower'), 0)
  assert.equal(improvementPct(null, 100, 'lower'), null)
})

test('truncateTail keeps the last lines and caps bytes', () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  const tail = truncateTail(text, 3)
  assert.equal(tail.split('\n').length, 3)
  assert.match(tail, /line 29/)
})
