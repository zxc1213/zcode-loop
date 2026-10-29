/**
 * Reports: a Markdown summary that drops into a weekly report, and a
 * self-contained HTML dashboard with an inline sparkline.
 */
import { improvementPct } from './stats.mjs'

const DECISION_LABEL = {
  baseline: 'baseline',
  keep: 'keep',
  revert: 'revert',
  drop: 'drop',
  error: 'error',
  noop: 'noop',
}

function fmt(value, unit = '') {
  if (value == null || !Number.isFinite(value)) return '—'
  const text = Math.abs(value) >= 1000 ? value.toFixed(0) : String(Number(value.toFixed(4)))
  return unit ? `${text} ${unit}` : text
}

function pct(value) {
  if (value == null) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function trialRows(state) {
  return state.trials.map((t) => ({
    n: t.n,
    decision: t.decision,
    label: DECISION_LABEL[t.decision] ?? t.decision,
    metric: t.metric,
    delta: improvementPct(t.metric, state.baseline, state.direction),
    note: t.note || t.hypothesis || '',
    commit: t.commit || '',
    ts: t.ts || '',
  }))
}

export function renderMarkdown(state) {
  const lines = []
  lines.push(`# Loop 报告：${state.goal || '(未命名目标)'}`)
  lines.push('')
  lines.push(
    `- 轮次：第 ${state.round} 轮${state.active ? '（进行中）' : '（已结束）'}　度量：\`${state.metric || '—'}\`　方向：${state.direction === 'higher' ? '越大越好' : '越小越好'}`,
  )
  lines.push(
    `- 基线：${fmt(state.baseline, state.unit)}　最佳：${fmt(state.best, state.unit)}　改善：${pct(state.deltaPct)}`,
  )
  lines.push(
    `- 试验：${state.trials.length}/${state.budget.maxTrials}　保留：${state.trials.filter((t) => t.decision === 'keep').length}　耗时：${state.budget.elapsedMinutes}/${state.budget.maxMinutes} 分钟`,
  )
  if (state.confidence) {
    lines.push(
      `- 置信度：${state.confidence.level}（信号 ${state.confidence.signalPct}% / 噪声 ${state.confidence.noisePct}%）`,
    )
  }
  if (state.plateau) lines.push('- ⚠️ 已进入平台期：最近 5 轮改善 < 1%')
  if (state.doomLoop) lines.push(`- ⚠️ 检测到重复/震荡尝试：${state.doomLoop.label}`)
  lines.push('')
  if (state.trials.length === 0) {
    lines.push('_还没有试验记录。_')
    return lines.join('\n')
  }
  lines.push('| # | 结论 | 度量 | 相对基线 | 说明 | 提交 |')
  lines.push('|---:|---|---:|---:|---|---|')
  for (const row of trialRows(state)) {
    lines.push(
      `| ${row.n} | ${row.label} | ${fmt(row.metric)} | ${pct(row.delta)} | ${String(row.note).replace(/\|/g, '\\|').slice(0, 80)} | ${row.commit || '—'} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

function sparkline(state) {
  const points = state.trials.filter((t) => Number.isFinite(t.metric))
  if (points.length < 2) return '<p class="muted">数据点不足，暂无可视化轨迹。</p>'
  const width = 720
  const height = 180
  const pad = 24
  const values = points.map((t) => t.metric)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0
  const coords = points.map((t, i) => {
    const x = pad + i * step
    const y = height - pad - ((t.metric - min) / span) * (height - pad * 2)
    return { x, y, t }
  })
  const poly = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
  const bestPoint = coords.reduce((acc, c) =>
    state.direction === 'higher' ? (c.t.metric > acc.t.metric ? c : acc) : c.t.metric < acc.t.metric ? c : acc,
  )
  const dots = coords
    .map((c) => {
      const cls = c.t.decision === 'keep' ? 'dot keep' : c.t.decision === 'baseline' ? 'dot base' : 'dot'
      return `<circle class="${cls}" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4"><title>#${c.t.n} ${esc(c.t.decision)} ${fmt(c.t.metric)}</title></circle>`
    })
    .join('')
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="metric trend">
  <polyline class="line" points="${poly}" />
  ${dots}
  <text class="axis" x="${pad}" y="16">${esc(fmt(max, state.unit))}</text>
  <text class="axis" x="${pad}" y="${height - 4}">${esc(fmt(min, state.unit))}</text>
  <circle class="dot best" cx="${bestPoint.x.toFixed(1)}" cy="${bestPoint.y.toFixed(1)}" r="7" />
</svg>`
}

export function renderHtml(state, generatedAt = new Date()) {
  const kept = state.trials.filter((t) => t.decision === 'keep').length
  const rows = trialRows(state)
    .map(
      (row) => `<tr class="${row.label}">
      <td class="num">${row.n}</td>
      <td><span class="badge ${row.label}">${esc(row.label)}</span></td>
      <td class="num">${esc(fmt(row.metric, state.unit))}</td>
      <td class="num ${row.delta > 0 ? 'good' : row.delta < 0 ? 'bad' : ''}">${pct(row.delta)}</td>
      <td>${esc(row.note)}</td>
      <td class="mono">${esc(row.commit || '—')}</td>
    </tr>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Loop 报告 · ${esc(state.goal || '未命名')}</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --panel:#171a21; --line:#262b36; --text:#e6e8ee; --muted:#8b93a7; --accent:#5aa9ff; --good:#3ecf8e; --bad:#ff6b6b; --warn:#ffb454; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 32px 24px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin-bottom: 24px; }
  .cards { display:grid; grid-template-columns: repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:20px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card .k { color:var(--muted); font-size:12px; }
  .card .v { font-size:20px; font-weight:600; margin-top:2px; }
  .v.good { color: var(--good); } .v.bad { color: var(--bad); } .v.warn { color: var(--warn); }
  section { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:18px; margin-bottom:18px; }
  svg { width:100%; height:auto; display:block; }
  .line { fill:none; stroke:var(--accent); stroke-width:2; }
  .dot { fill:#4a5266; } .dot.keep { fill:var(--good); } .dot.base { fill:var(--accent); } .dot.best { fill:none; stroke:var(--warn); stroke-width:2; }
  .axis { fill:var(--muted); font-size:11px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  td.num, th.num { text-align:right; font-variant-numeric: tabular-nums; }
  .good { color:var(--good); } .bad { color:var(--bad); }
  .mono { font-family: ui-monospace,SFMono-Regular,Consolas,monospace; color:var(--muted); }
  .badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; border:1px solid var(--line); color:var(--muted); }
  .badge.keep { color:var(--good); border-color:var(--good); }
  .badge.revert, .badge.drop, .badge.error { color:var(--bad); border-color:var(--bad); }
  .badge.baseline { color:var(--accent); border-color:var(--accent); }
  .muted { color:var(--muted); }
  .warnbox { border-color: var(--warn); color: var(--warn); }
</style>
</head>
<body>
<main>
  <h1>${esc(state.goal || '未命名实验目标')}</h1>
  <div class="sub">第 ${state.round} 轮 · ${state.direction === 'higher' ? '越大越好' : '越小越好'} · 生成于 ${esc(generatedAt.toLocaleString())}</div>
  <div class="cards">
    <div class="card"><div class="k">基线</div><div class="v">${esc(fmt(state.baseline, state.unit))}</div></div>
    <div class="card"><div class="k">最佳</div><div class="v">${esc(fmt(state.best, state.unit))}</div></div>
    <div class="card"><div class="k">改善</div><div class="v ${state.deltaPct > 0 ? 'good' : state.deltaPct < 0 ? 'bad' : ''}">${pct(state.deltaPct)}</div></div>
    <div class="card"><div class="k">试验 / 保留</div><div class="v">${state.trials.length} / ${kept}</div></div>
    <div class="card"><div class="k">预算</div><div class="v">${state.budget.used}/${state.budget.maxTrials}</div></div>
    <div class="card"><div class="k">置信度</div><div class="v ${state.confidence?.level === 'high' ? 'good' : state.confidence?.level === 'low' ? 'bad' : ''}">${state.confidence?.level ?? '—'}</div></div>
  </div>
  ${state.plateau ? '<section class="warnbox">⚠️ 已进入平台期：最近 5 轮改善 &lt; 1%，建议复测确认或换目标。</section>' : ''}
  ${state.doomLoop ? `<section class="warnbox">⚠️ 检测到${state.doomLoop.pattern === 'oscillate' ? '震荡' : '重复'}尝试：${esc(state.doomLoop.label)}</section>` : ''}
  <section>
    <h2 style="font-size:15px;margin:0 0 12px">度量轨迹</h2>
    ${sparkline(state)}
  </section>
  <section>
    <h2 style="font-size:15px;margin:0 0 12px">试验记录</h2>
    <table>
      <thead><tr><th class="num">#</th><th>结论</th><th class="num">度量</th><th class="num">相对基线</th><th>说明</th><th>提交</th></tr></thead>
      <tbody>
      ${rows || '<tr><td colspan="6" class="muted">还没有试验记录。</td></tr>'}
      </tbody>
    </table>
  </section>
</main>
</body>
</html>
`
}
