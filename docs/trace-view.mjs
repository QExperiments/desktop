#!/usr/bin/env node
// Session trace as one HTML page: a wrapper over a Claude Code transcript
// (.jsonl). Nothing is retyped: the page inlines a compact projection of the
// records (user prompt → what the assistant said it would do → tool calls →
// results, clipped) and links every row to its line in the source file.
//   node trace-view.mjs <session.jsonl> <out.html> [--clip 3000]
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

const [src, out] = process.argv.slice(2)
if (!src || !out) { console.error('usage: node trace-view.mjs <session.jsonl> <out.html> [--clip N]'); process.exit(1) }
const clipAt = Number(process.argv[process.argv.indexOf('--clip') + 1]) || 3000
const clip = (s, n = clipAt) => (s == null ? '' : String(s).length > n ? `${String(s).slice(0, n)}\n… [${String(s).length - n} more chars, see the jsonl line]` : String(s))

const lines = (await readFile(src, 'utf8')).split('\n')
const short = (s, n = 140) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const rel = (p) => String(p ?? '').replace(/^\/Users\/[^/]+\/vs_code_projects\/qvac\//, '')

// One line per tool call: what it was for, not its whole input.
const summaryOf = (name, input = {}) => {
  if (name === 'Bash') return input.description || short(input.command, 120)
  if (['Read', 'Write', 'Edit'].includes(name)) return rel(input.file_path) + (name === 'Edit' ? ` · ${short(input.old_string, 50)} → ${short(input.new_string, 50)}` : '')
  if (name === 'Agent') return input.description || short(input.prompt, 120)
  if (name === 'ToolSearch') return input.query
  if (name === 'Artifact') return `${input.action ?? 'publish'} ${rel(input.file_path ?? input.url ?? '')}`
  if (name.startsWith('mcp__claude-in-chrome__')) return [input.action, input.url, input.text, input.pattern].filter(Boolean).join(' ') || name.replace('mcp__claude-in-chrome__', '')
  return short(JSON.stringify(input), 120)
}

const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'))
const resultText = (block, record) => {
  const fromBlock = typeof block.content === 'string' ? block.content : (block.content ?? []).map((c) => c.text ?? (c.type === 'tool_reference' ? `[tool ${c.tool_name ?? ''}]` : c.type === 'image' ? '[image]' : '')).join('\n')
  if (fromBlock.trim()) return fromBlock
  const r = record.toolUseResult
  if (r && typeof r === 'object') return [r.stdout, r.stderr].filter(Boolean).join('\n') || short(JSON.stringify(r), 2000)
  return ''
}

const turns = []
const toolsByName = {}
const pending = new Map() // tool_use id → step
let current = null
const newTurn = (fields) => { current = { steps: [], tool_calls: 0, ...fields }; turns.push(current); return current }

lines.forEach((raw, index) => {
  if (!raw.trim()) return
  let j
  try { j = JSON.parse(raw) } catch { return }
  const line = index + 1
  const ts = j.timestamp ?? null

  if (j.type === 'system' && j.subtype === 'compact_boundary') { newTurn({ line, ts, kind: 'compact', prompt: 'context compacted', duration_ms: null }); return }
  if (j.type === 'system' && j.subtype === 'turn_duration' && current) { current.duration_ms = j.durationMs ?? null; return }
  if (j.type !== 'user' && j.type !== 'assistant') return
  const content = j.message?.content
  const blocks = Array.isArray(content) ? content : []

  if (j.type === 'user') {
    const results = blocks.filter((b) => b.type === 'tool_result')
    if (results.length) {
      for (const b of results) {
        const step = pending.get(b.tool_use_id)
        if (!step) continue
        const text = resultText(b, j)
        step.result = { line, ts, len: text.length, text: clip(text), error: b.is_error === true || /^(Error|Exit code [1-9])/m.test(text.slice(0, 200)) }
        pending.delete(b.tool_use_id)
      }
      return
    }
    if (j.isCompactSummary) { const t = newTurn({ line, ts, kind: 'compact', prompt: clip(textOf(content), 4000), duration_ms: null }); return }
    if (j.isMeta) return
    const text = textOf(content)
    if (!text.trim() || (typeof content === 'string' && content.startsWith('<'))) return
    const images = blocks.filter((b) => b.type === 'image').length
    if (/^\[Request interrupted by user\]/.test(text) && current) { current.steps.push({ line, ts, kind: 'note', text: 'request interrupted by user' }); return }
    newTurn({ line, ts, kind: 'prompt', prompt: clip(text, 4000), images, duration_ms: null })
    return
  }

  // assistant
  if (!current) newTurn({ line, ts, kind: 'prompt', prompt: '(session start)', duration_ms: null })
  for (const b of blocks) {
    if (b.type === 'text' && b.text.trim()) current.steps.push({ line, ts, kind: 'text', text: b.text })
    if (b.type === 'tool_use') {
      const step = { line, ts, kind: 'tool', id: b.id, name: b.name, summary: summaryOf(b.name, b.input), input: clip(JSON.stringify(b.input, null, 1)), result: null }
      current.steps.push(step)
      pending.set(b.id, step)
      current.tool_calls++
      toolsByName[b.name] = (toolsByName[b.name] ?? 0) + 1
    }
  }
})

const stamps = turns.flatMap((t) => [t.ts, ...t.steps.flatMap((s) => [s.ts, s.result?.ts])]).filter(Boolean).sort()
const data = {
  source: src, file: basename(src), generated: new Date().toISOString(), started: stamps[0] ?? null, ended: stamps.at(-1) ?? null,
  lines: lines.filter((l) => l.trim()).length, turns, tools: toolsByName,
  tool_calls: Object.values(toolsByName).reduce((a, b) => a + b, 0), prompts: turns.filter((t) => t.kind === 'prompt').length,
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trace ${data.file.slice(0, 8)} · ${(data.started ?? '').slice(0, 10)}</title>
<style>
  :root { --ink: #1c1c1c; --muted: #666; --line: #ddd; --ok: #1a7f37; --bad: #b3261e; --warn: #9a6700; --bg: #fff; --alt: #f6f6f6; --user: #eef3ff; }
  body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); margin: 0; padding: 24px 16px 64px; max-width: 1200px; margin-inline: auto; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 0; font-weight: 600; display: inline; }
  .sub { color: var(--muted); margin-bottom: 12px; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 12px; font-size: 13px; } th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; } th { background: var(--alt); font-weight: 600; white-space: nowrap; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ok { color: var(--ok); } .bad { color: var(--bad); } .muted { color: var(--muted); }
  details.turn { margin: 10px 0; border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; } details.turn > summary { cursor: pointer; }
  details.turn.compact { background: var(--alt); }
  .prompt { background: var(--user); padding: 8px 10px; border-radius: 6px; white-space: pre-wrap; margin: 8px 0; max-height: 240px; overflow: auto; }
  .intent { white-space: pre-wrap; }
  .tool { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: var(--alt); padding: 0 5px; border-radius: 3px; }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--alt); padding: 6px 8px; border-radius: 4px; max-height: 320px; overflow: auto; font-size: 12px; margin: 4px 0; }
  details.res > summary { cursor: pointer; color: var(--muted); }
  .small { font-size: 12px; color: var(--muted); }
  .controls { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin: 8px 0 14px; font-size: 13px; } .controls input[type=search] { font: inherit; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; min-width: 260px; }
  .hidden { display: none; }
  a { color: inherit; }
</style>
</head>
<body>
<h1 id="title"></h1>
<div class="sub" id="sub"></div>
<div class="controls">
  <input type="search" id="q" placeholder="filter steps (intent, tool, summary, result)">
  <label><input type="checkbox" id="showText" checked> intents</label>
  <label><input type="checkbox" id="showTools" checked> tool calls</label>
  <label><input type="checkbox" id="openResults"> results expanded</label>
  <button type="button" id="collapse">collapse all</button>
  <button type="button" id="expand">expand all</button>
</div>
<div id="stats"></div>
<div id="root"></div>
<script id="data" type="application/json">${JSON.stringify(data).replace(/<\/script/gi, '<\\/script')}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent)
const $ = (tag, attrs = {}, ...kids) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) k === 'class' ? el.className = v : k === 'html' ? el.innerHTML = v : el.setAttribute(k, v); for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid?.nodeType ? kid : document.createTextNode(String(kid))); return el }
const hhmm = (ts) => ts ? new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
const dur = (ms) => ms == null ? '' : ms < 60000 ? Math.round(ms / 1000) + ' s' : Math.round(ms / 60000) + ' min'
const table = (headers, rows, numeric = []) => $('table', {}, $('thead', {}, $('tr', {}, headers.map((h, i) => $('th', { class: numeric.includes(i) ? 'num' : '' }, h)))), $('tbody', {}, rows.map((r) => $('tr', {}, r.map((c, i) => $('td', { class: (numeric.includes(i) ? 'num ' : '') + (c && c.cls ? c.cls : '') }, c && c.text !== undefined ? c.text : c))))))

document.getElementById('title').textContent = 'Session trace ' + D.file.replace('.jsonl', '')
document.getElementById('sub').textContent = (D.started || '').slice(0, 10) + ' ' + hhmm(D.started) + ' → ' + hhmm(D.ended) + ' · ' + D.prompts + ' prompts · ' + D.tool_calls + ' tool calls · ' + D.lines + ' jsonl lines · source ' + D.source
const stats = document.getElementById('stats')
stats.append(table(['tool', 'calls'], Object.entries(D.tools).sort((a, b) => b[1] - a[1]).map(([k, v]) => [$('span', { class: 'tool' }, k), v]), [1]))
stats.append(table(['#', 'time', 'prompt', 'steps', 'tool calls', 'turn duration'], D.turns.map((t, i) => [i + 1, hhmm(t.ts), $('a', { href: '#turn-' + (i + 1) }, t.kind === 'compact' ? '— context compacted —' : (t.prompt || '').replace(/\\s+/g, ' ').slice(0, 110)), t.steps.length, t.tool_calls, dur(t.duration_ms)]), [0, 3, 4, 5]))

const root = document.getElementById('root')
D.turns.forEach((t, i) => {
  const det = $('details', { class: 'turn' + (t.kind === 'compact' ? ' compact' : ''), id: 'turn-' + (i + 1), open: '' })
  det.append($('summary', {}, $('h2', {}, '#' + (i + 1) + ' '), $('span', { class: 'muted' }, hhmm(t.ts) + ' · '), (t.kind === 'compact' ? '— context compacted —' : (t.prompt || '').replace(/\\s+/g, ' ').slice(0, 140)), $('span', { class: 'muted' }, ' · ' + t.steps.length + ' steps, ' + t.tool_calls + ' tool calls' + (t.duration_ms != null ? ', ' + dur(t.duration_ms) : '') + (t.images ? ', ' + t.images + ' image(s)' : '') + ' · jsonl:' + t.line)))
  det.append($('div', { class: 'prompt' }, t.prompt))
  const rows = t.steps.map((s) => {
    const tr = $('tr', { class: 'step ' + s.kind })
    tr.dataset.text = ((s.text || '') + ' ' + (s.name || '') + ' ' + (s.summary || '') + ' ' + (s.result?.text || '')).toLowerCase()
    tr.append($('td', { class: 'num muted' }, s.line), $('td', { class: 'num muted' }, hhmm(s.ts)))
    if (s.kind === 'text') tr.append($('td', { colspan: 3 }, $('div', { class: 'intent' }, s.text)))
    else if (s.kind === 'note') tr.append($('td', { colspan: 3, class: 'muted' }, s.text))
    else {
      tr.append($('td', {}, $('span', { class: 'tool' }, s.name)), $('td', {}, s.summary, $('details', { class: 'res' }, $('summary', {}, 'input'), $('pre', {}, s.input))))
      const r = s.result
      tr.append($('td', {}, r ? $('details', { class: 'res' }, $('summary', { class: r.error ? 'bad' : '' }, (r.error ? 'error · ' : '') + r.len + ' chars · ' + hhmm(r.ts) + ' · jsonl:' + r.line), $('pre', {}, r.text)) : $('span', { class: 'muted' }, 'no result recorded')))
    }
    return tr
  })
  det.append($('table', {}, $('thead', {}, $('tr', {}, ['jsonl', 'time', 'tool', 'what I did / meant to do', 'result'].map((h) => $('th', {}, h)))), $('tbody', {}, rows)))
  root.append(det)
})

const apply = () => {
  const q = document.getElementById('q').value.trim().toLowerCase()
  const showText = document.getElementById('showText').checked, showTools = document.getElementById('showTools').checked, openResults = document.getElementById('openResults').checked
  for (const tr of document.querySelectorAll('tr.step')) {
    const kind = tr.classList.contains('text') ? 'text' : tr.classList.contains('tool') ? 'tool' : 'note'
    const hide = (kind === 'text' && !showText) || (kind === 'tool' && !showTools) || (q && !tr.dataset.text.includes(q))
    tr.classList.toggle('hidden', hide)
    for (const d of tr.querySelectorAll('td:last-child details.res')) d.open = openResults
  }
  for (const det of document.querySelectorAll('details.turn')) det.classList.toggle('hidden', q && ![...det.querySelectorAll('tr.step')].some((tr) => !tr.classList.contains('hidden')))
}
for (const id of ['q', 'showText', 'showTools', 'openResults']) document.getElementById(id).addEventListener('input', apply)
document.getElementById('collapse').onclick = () => document.querySelectorAll('details.turn').forEach((d) => { d.open = false })
document.getElementById('expand').onclick = () => document.querySelectorAll('details.turn').forEach((d) => { d.open = true })
</script>
</body>
</html>
`
await writeFile(out, html)
console.log(`${out}: ${data.turns.length} turns (${data.prompts} prompts), ${data.tool_calls} tool calls, ${(html.length / 1024 ** 2).toFixed(1)} MB`)
