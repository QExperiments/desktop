#!/usr/bin/env node
// `npm run eval:compare -- <results dir>...`: the multiquery metrics of several
// runs side by side, the first directory being the reference (ADR-012). Reads
// header.json, metrics.json and turns.jsonl of each run; writes compare.md and
// compare.html (self-contained, no CDN) into --out, by default
// evals/results/compare-<ts>/. Nothing here calls a model.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const { values: flags, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, names: { type: 'string' } } })
if (positionals.length < 2) {
  console.error('usage: node evals/compare.mjs <results dir> <results dir> [more...] [--out dir] [--names a,b,c]')
  process.exit(2)
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const readJsonl = async (path) => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
const fin = (v) => typeof v === 'number' && Number.isFinite(v)
const mean = (values) => { const k = values.filter(fin); return k.length ? k.reduce((a, b) => a + b, 0) / k.length : null }
const pct = (v) => (fin(v) ? `${Math.round(v * 100)}%` : 'n/a')
const num = (v, d = 0) => (fin(v) ? Number(v).toFixed(d) : 'n/a')
const ms = (v) => (fin(v) ? `${Math.round(v)} ms` : 'n/a')
const names = flags.names ? flags.names.split(',').map((s) => s.trim()) : null

const runs = []
for (const [i, dir] of positionals.map((p) => resolve(p)).entries()) {
  const header = await readJson(join(dir, 'header.json'))
  const metrics = await readJson(join(dir, 'metrics.json'))
  const turns = (await readJsonl(join(dir, 'turns.jsonl'))).filter((t) => t.category === 'multiquery')
  if (!metrics.multiquery) throw new Error(`${dir}: no multiquery block in metrics.json`)
  runs.push({ dir, name: names?.[i] ?? header.variant ?? 'baseline', header, m: metrics.multiquery, latency: metrics.multiquery.latency ?? {}, tokens: metrics.multiquery.tokens ?? {}, turns })
}
const ref = runs[0]

// ---- rows: [label, kind, pick(run)]; kind decides the format and the delta
// (tokens and ms: relative change; rates: percentage points; numbers: absolute).
const T = (label, pick, kind = 'tokens') => ({ label, pick, kind })
const tokenRows = [
  T('prompt tokens per turn (usage, rewrite included)', (r) => r.tokens.prompt_mean),
  T('prefill tokens per turn (processed, answer path)', (r) => r.tokens.prefill_mean),
  T('cached tokens per turn', (r) => r.tokens.cached_mean),
  T('completion tokens per turn, mean', (r) => r.tokens.completion_mean),
  T('completion tokens per turn, median', (r) => r.tokens.completion_p50),
  T('completion tokens, max (runaway answers)', (r) => r.tokens.completion_max),
  T('rewrite tokens per turn (turns with a rewrite)', (r) => r.tokens.rewrite_mean),
  T('total tokens per turn', (r) => r.tokens.total_mean),
  T('total tokens per session', (r) => r.tokens.session_total_mean),
  T('prefill tokens per session', (r) => r.tokens.session_prefill_mean),
  T('context tokens, mean of the largest round', (r) => r.tokens.context_mean),
  T('context tokens, max', (r) => r.tokens.context_max),
]
const retrievalRows = [
  T('recall@k, all turns with gold', (r) => r.m.all?.recall, 'rate'),
  T('recall@k, standalone', (r) => r.m.standalone?.recall, 'rate'),
  T('recall@k, follow-up', (r) => r.m.followup?.recall, 'rate'),
  T('precision@3, all', (r) => r.m.all?.precision, 'rate'),
  T('hit@3, all', (r) => r.m.all?.hit, 'rate'),
  T('MRR, all', (r) => r.m.all?.mrr, 'num2'),
  T('evidence in context, all', (r) => r.m.all?.evidence_in_context, 'rate'),
  T('evidence in context, follow-up', (r) => r.m.followup?.evidence_in_context, 'rate'),
  T('context recall, all', (r) => r.m.all?.context_recall, 'rate'),
]
const behaviourRows = [
  T('turns with fresh excerpts shown', (r) => r.tokens.turns_with_fresh_excerpts, 'rate'),
  T('fresh excerpts per turn', (r) => r.tokens.fresh_excerpts_mean, 'num2'),
  T('search_documents calls per turn', (r) => r.tokens.search_calls_per_turn, 'num2'),
  T('turns with a search_documents call', (r) => r.tokens.turns_with_search, 'rate'),
  T('rewrite used (turns with a rewrite)', (r) => r.tokens.rewrite_used, 'rate'),
  T('completion rounds per turn', (r) => r.m.stats?.rounds_mean, 'num2'),
  T('lookup_stock calls', (r) => r.m.stats?.per_tool?.lookup_stock ?? 0, 'num'),
  T('tool limit hits', (r) => r.m.stats?.limit_hits, 'num'),
  T('abstained on no-answer turns (code)', (r) => r.m.no_answer?.abstained_rate, 'rate'),
  T('false abstain on turns with gold (code)', (r) => r.m.false_abstain_rate, 'rate'),
  T('grounded (numbers from shown context)', (r) => r.m.grounded_rate, 'rate'),
  T('citation precision', (r) => r.m.citation_precision_mean, 'rate'),
  T('leak', (r) => r.m.leak_rate, 'rate'),
  T('language matches', (r) => r.m.lang_rate, 'rate'),
  T('errors', (r) => r.latency.errors, 'num'),
]
const latencyRows = [
  T('ttft p50', (r) => r.latency.ttft_p50, 'ms'),
  T('ttft p95', (r) => r.latency.ttft_p95, 'ms'),
  T('total p50 (wall)', (r) => r.latency.total_p50, 'ms'),
  T('total p95 (wall)', (r) => r.latency.total_p95, 'ms'),
  T('retrieval ms per turn', (r) => r.tokens.retrieval_ms_mean, 'ms'),
  T('rewrite ms (turns with a rewrite)', (r) => r.tokens.rewrite_ms_mean, 'ms'),
  T('cache ratio', (r) => r.latency.cache_ratio_mean, 'rate'),
  T('prefill tps p50', (r) => r.latency.prefill_tps_p50, 'num'),
  T('tps p50', (r) => r.latency.tps_p50, 'num'),
]

const fmt = (v, kind) => kind === 'rate' ? pct(v) : kind === 'ms' ? ms(v) : kind === 'num2' ? num(v, 2) : num(v)
const delta = (v, base, kind) => {
  if (!fin(v) || !fin(base)) return ''
  if (kind === 'rate') { const d = Math.round((v - base) * 100); return d === 0 ? '±0 pp' : `${d > 0 ? '+' : ''}${d} pp` }
  if (kind === 'tokens' || kind === 'ms') { if (base === 0) return ''; const d = Math.round(((v - base) / base) * 100); return d === 0 ? '±0%' : `${d > 0 ? '+' : ''}${d}%` }
  const d = kind === 'num2' ? Number((v - base).toFixed(2)) : Math.round(v - base)
  return d === 0 ? '±0' : `${d > 0 ? '+' : ''}${kind === 'num2' ? d.toFixed(2) : d}`
}
// One row per metric: the reference value, then each other run's value with its delta.
const compareTable = (rows) => rows.map(({ label, pick, kind }) => {
  const base = pick(ref)
  return [label, fmt(base, kind), ...runs.slice(1).flatMap((r) => { const v = pick(r); return [fmt(v, kind), delta(v, base, kind)] })]
}).filter((row) => row.slice(1).some((cell) => cell !== 'n/a' && cell !== ''))
const compareHeaders = ['metric', ref.name, ...runs.slice(1).flatMap((r) => [r.name, 'Δ'])]

// Per-session totals and recall, per turn position tokens, and the turns
// whose retrieval differs between runs.
const sessionKey = (t) => `${t.id}#${t.run}`
const sessions = [...new Set(ref.turns.map(sessionKey))]
const sessionRows = sessions.map((key) => {
  const cells = [key.replace('#', ' r')]
  for (const r of runs) {
    const rows = r.turns.filter((t) => sessionKey(t) === key && !t.error)
    cells.push(num(rows.reduce((s, t) => s + (t.usage?.total_tokens ?? 0), 0)), pct(mean(rows.filter((t) => t.has_gold).map((t) => t.recall))))
  }
  return cells
})
const sessionHeaders = ['session', ...runs.flatMap((r) => [`${r.name} tokens`, `${r.name} recall@k`])]

const maxTurn = Math.max(...runs.flatMap((r) => r.turns.map((t) => t.turn)))
const byTurnRows = Array.from({ length: maxTurn }, (_, i) => i + 1).map((turn) => {
  const cells = [String(turn)]
  for (const r of runs) {
    const rows = r.turns.filter((t) => t.turn === turn && !t.error)
    cells.push(String(rows.length), num(mean(rows.map((t) => t.usage?.prompt_tokens))), num(mean(rows.map((t) => t.stats?.prefill_tokens))), pct(mean(rows.filter((t) => t.has_gold).map((t) => t.recall))))
  }
  return cells
})
const byTurnHeaders = ['turn', ...runs.flatMap((r) => [`${r.name} n`, 'prompt', 'prefill', 'recall@k'])]

const turnKey = (t) => `${t.id}#${t.run}#${t.turn}`
const diffRows = []
for (const t of ref.turns) {
  if (!t.has_gold) continue
  const others = runs.slice(1).map((r) => r.turns.find((o) => turnKey(o) === turnKey(t)))
  const values = [t, ...others].map((o) => (o ? o.recall : null))
  if (values.every((v) => v === values[0])) continue
  diffRows.push([`${t.id} t${t.turn}${t.followup ? ' (follow-up)' : ''}`, t.query.length > 90 ? `${t.query.slice(0, 87)}…` : t.query, ...[t, ...others].map((o) => (o ? `${pct(o.recall)}${o.rewrite?.used ? ` → "${o.rewrite.to.slice(0, 60)}"` : ''}${(o.search_calls ?? 0) > 0 ? ` (${o.search_calls} search)` : ''}` : 'n/a'))])
}
const diffHeaders = ['turn', 'query', ...runs.map((r) => `${r.name} recall@k`)]

const runHeaders = ['run', 'variant', 'serve env', 'ts', 'tier', 'chat model', 'turns', 'errors', 'cold start']
const runRows = runs.map((r) => [basename(r.dir), r.header.variant ?? 'baseline (defaults)', Object.entries(r.header.serverEnv ?? {}).map(([k, v]) => `${k}=${v}`).join(' ') || '—', r.header.ts, r.header.tier, r.header.chatModel ?? '?', String(r.latency.n ?? r.turns.length), String(r.latency.errors ?? 0), ms(r.header.coldStartMs)])

// ---- markdown
const mdTable = (headers, rows) => [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n')
const md = [
  `# Retrieval strategies compared · multiquery · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, '',
  `Reference is the first run (${ref.name}); Δ is against it: relative for tokens and times, percentage points for rates.`, '',
  '## Runs', '', mdTable(runHeaders, runRows), '',
  '## Tokens', '', mdTable(compareHeaders, compareTable(tokenRows)), '',
  '## Retrieval as the model saw it (k = 3)', '', mdTable(compareHeaders, compareTable(retrievalRows)), '',
  'recall@k counts the hits of the turn itself (automatic search or search_documents results), k being the chunks the run showed per turn (3 unless MERIDIAN_CHAT_TOPK); evidence in context also counts gold shown earlier in the session, except under MERIDIAN_CONTEXT_LAYOUT=current where nothing earlier is in the context.', '',
  '## Behaviour', '', mdTable(compareHeaders, compareTable(behaviourRows)), '',
  '## Latency', '', mdTable(compareHeaders, compareTable(latencyRows)), '',
  '## Per session', '', mdTable(sessionHeaders, sessionRows), '',
  '## By turn position', '', mdTable(byTurnHeaders, byTurnRows), '',
  `## Turns whose recall differs (${diffRows.length})`, '', diffRows.length ? mdTable(diffHeaders, diffRows) : 'none', '',
].join('\n')

// ---- html, same look as report.html
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const cls = (cell, i, headers) => {
  const numeric = i > 0 && !/^(query|variant|serve env|ts|chat model|run)$/.test(headers[i])
  const tone = headers[i] === 'Δ' && cell ? (cell.startsWith('+') ? 'up' : cell.startsWith('-') || cell.startsWith('−') ? 'down' : '') : ''
  return `${numeric ? 'num' : ''} ${tone}`.trim()
}
const htmlTable = (headers, rows) => `<div class="wrap"><table><thead><tr>${headers.map((h) => `<th${/^(query|variant|serve env|ts|chat model|run|metric|session|turn)$/.test(h) ? '' : ' class="num"'}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((c, i) => `<td class="${cls(String(c), i, headers)}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Retrieval strategies · multiquery</title>
<style>
  :root { --ink: #1c1c1c; --muted: #666; --line: #ddd; --ok: #1a7f37; --bad: #b3261e; --bg: #fff; --alt: #f6f6f6; }
  body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); margin: 0; padding: 24px 16px 64px; max-width: 1200px; margin-inline: auto; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 32px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
  .sub { color: var(--muted); margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 12px; font-size: 13px; } th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; } th { background: var(--alt); font-weight: 600; white-space: nowrap; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .up { color: var(--ok); } .down { color: var(--bad); }
  .wrap { overflow-x: auto; } .small { font-size: 12px; color: var(--muted); }
</style></head><body>
<h1>Retrieval strategies compared · multiquery</h1>
<div class="sub">Reference is the first run (${esc(ref.name)}); Δ is against it: relative for tokens and times, percentage points for rates. Green marks an increase, red a decrease; whether that is good depends on the row.</div>
<h2>Runs</h2>${htmlTable(runHeaders, runRows)}
<h2>Tokens</h2>${htmlTable(compareHeaders, compareTable(tokenRows))}
<h2>Retrieval as the model saw it (k = 3)</h2>${htmlTable(compareHeaders, compareTable(retrievalRows))}
<p class="small">recall@k counts the hits of the turn itself (automatic search or search_documents results), k being the chunks the run showed per turn (3 unless MERIDIAN_CHAT_TOPK); evidence in context also counts gold shown earlier in the session, except under MERIDIAN_CONTEXT_LAYOUT=current where nothing earlier is in the context.</p>
<h2>Behaviour</h2>${htmlTable(compareHeaders, compareTable(behaviourRows))}
<h2>Latency</h2>${htmlTable(compareHeaders, compareTable(latencyRows))}
<h2>Per session</h2>${htmlTable(sessionHeaders, sessionRows)}
<h2>By turn position</h2>${htmlTable(byTurnHeaders, byTurnRows)}
<h2>Turns whose recall differs (${diffRows.length})</h2>${diffRows.length ? htmlTable(diffHeaders, diffRows) : '<p>none</p>'}
</body></html>
`

const out = resolve(flags.out ?? join(here, 'results', `compare-${new Date().toISOString().replace(/[:.]/g, '-')}`))
await mkdir(out, { recursive: true })
await writeFile(join(out, 'compare.md'), md)
await writeFile(join(out, 'compare.html'), html)
console.log(md)
console.log(`\nwritten: ${join(out, 'compare.md')}, ${join(out, 'compare.html')}`)
