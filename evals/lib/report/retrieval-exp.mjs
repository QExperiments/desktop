// Report of the retrieval experiment (docs/todo-3-exp.md): reads
// variant-<v>.json and turns-<v>.jsonl of a results directory, compares every
// variant with B0 (or the first variant) and writes compare.md and
// compare.html. Also `pickBest`, the rule that composes BEST from the winners.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const fin = (v) => typeof v === 'number' && Number.isFinite(v)
const mean = (values) => { const k = values.filter(fin); return k.length ? k.reduce((a, b) => a + b, 0) / k.length : null }
const pct = (v) => (fin(v) ? `${Math.round(v * 100)}%` : 'n/a')
const pp = (v, base) => { if (!fin(v) || !fin(base)) return ''; const d = Math.round((v - base) * 100); return d === 0 ? '±0' : `${d > 0 ? '+' : ''}${d}` }
const num = (v, d = 0) => (fin(v) ? Number(v).toFixed(d) : 'n/a')
const mb = (b) => (fin(b) ? `${(b / 1e6).toFixed(0)} MB` : 'n/a')
const kb = (b) => (fin(b) ? `${(b / 1e3).toFixed(0)} KB` : 'n/a')
const sec = (msv) => (fin(msv) ? `${(msv / 1000).toFixed(1)} s` : 'n/a')
const readJsonl = async (path) => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

// The four queries the plan watches by hand, with the rank of every gold file.
export const CANARIES = ['retrieval-36', 'retrieval-129', 'retrieval-120', 'retrieval-07']

export const loadVariants = async (dir) => {
  const files = (await readdir(dir)).filter((f) => /^variant-.*\.json$/.test(f))
  const spec = JSON.parse(await readFile(join(dir, 'variants.json'), 'utf8').catch(() => '{}'))
  const variants = []
  for (const file of files) {
    const summary = JSON.parse(await readFile(join(dir, file), 'utf8'))
    const turns = await readJsonl(join(dir, `turns-${summary.variant}.jsonl`))
    variants.push({ name: summary.variant, summary, turns, meta: spec.variants?.[summary.variant] ?? {} })
  }
  const order = Object.keys(spec.variants ?? {})
  variants.sort((a, b) => (order.indexOf(a.name) === -1 ? 999 : order.indexOf(a.name)) - (order.indexOf(b.name) === -1 ? 999 : order.indexOf(b.name)) || a.name.localeCompare(b.name))
  const refIndex = variants.findIndex((v) => v.name === 'B0')
  if (refIndex > 0) variants.unshift(...variants.splice(refIndex, 1))
  return variants
}

// ---- slices: recall@3 of a subset of queries, or hit@3 of (query, gold file) pairs
const recallAt = (turn, k) => turn.at?.[k]?.recall
const sliceDefs = [
  ['original 12 (no source tag)', (t) => !t.tags.some((x) => x.startsWith('source:'))],
  ['multiquery standalone', (t) => t.tags.includes('standalone')],
  ['multiquery follow-up, reworded', (t) => t.tags.includes('followup:resolved')],
  ['handwritten · question', (t) => t.tags.includes('style:question')],
  ['handwritten · keyword', (t) => t.tags.includes('style:keyword')],
  ['handwritten · paraphrase', (t) => t.tags.includes('style:paraphrase')],
  // Query-from-history cases (evals/exp/cases-history): kind and turn position.
  ['follow-up turns', (t) => t.tags.includes('kind:followup')],
  ['standalone turns', (t) => t.tags.includes('kind:standalone')],
  ['turn 1', (t) => t.tags.includes('turn:1')],
  ['turns 2–3', (t) => t.tags.includes('turn:2') || t.tags.includes('turn:3')],
  ['turns 4+', (t) => t.tags.some((x) => /^turn:\d+$/.test(x) && Number(x.slice(5)) >= 4)],
  ['1 gold file', (t) => t.gold.length === 1],
  ['2 gold files', (t) => t.gold.length === 2],
  ['3+ gold files', (t) => t.gold.length >= 3],
]
const goldGroups = [
  ['gold in emails/', (f) => f.startsWith('emails/')],
  ['gold in reports/', (f) => f.startsWith('reports/')],
  ['gold in policies/', (f) => f.startsWith('policies/')],
  ['gold in faqs/', (f) => f.startsWith('faqs/')],
  ['gold in data/', (f) => f.startsWith('data/')],
  ['gold in transcripts/', (f) => f.startsWith('transcripts/')],
  ['gold is .csv', (f) => f.endsWith('.csv')],
  ['gold is .json', (f) => f.endsWith('.json')],
  ['gold is .html', (f) => f.endsWith('.html')],
  ['gold is .txt', (f) => f.endsWith('.txt')],
]
const goldFound = (turn, file, k = 3) => turn.gold_ranks?.find((g) => g.file === file)?.rank <= k
const sliceValue = (variant, def) => mean(variant.turns.filter(def[1]).map((t) => recallAt(t, 3)))
const goldValue = (variant, def) => mean(variant.turns.flatMap((t) => t.gold.filter(def[1]).map((f) => (goldFound(t, f) ? 1 : 0))))

// Paired comparison at recall@3: queries better / worse than the reference and
// a two-sided sign test on those counts (binomial, p = 0.5).
const paired = (variant, ref) => {
  let better = 0, worse = 0
  const byId = new Map(ref.turns.map((t) => [t.id, t]))
  for (const t of variant.turns) {
    const r = byId.get(t.id)
    if (!r) continue
    const a = recallAt(t, 3), b = recallAt(r, 3)
    if (!fin(a) || !fin(b)) continue
    if (a > b + 1e-9) better++
    else if (a < b - 1e-9) worse++
  }
  return { better, worse, p: signTest(better, worse) }
}
const signTest = (a, b) => {
  const n = a + b
  if (n === 0) return 1
  const k = Math.min(a, b)
  const choose = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r }
  let tail = 0
  for (let i = 0; i <= k; i++) tail += choose(n, i)
  return Math.min(1, (2 * tail) / 2 ** n)
}

// ---- BEST: the per-axis winners over the reference, merged into one env.
// embedding and chunking are exclusive: the single best of each if it beats
// B0 on recall@3. preparation and fusion knobs are independent: every one that
// beats B0 with more queries up than down. fts: the better of F3/F4 (F4
// already turns stemming off). Gemma-only knobs (prefix, MRL) are dropped
// when the winning model is not EmbeddingGemma.
export const pickBest = async (dir, all) => {
  const variants = await loadVariants(dir)
  const ref = variants[0]
  if (!ref || ref.name !== 'B0') return null
  const base = ref.summary.aggregate.at[3].recall
  const score = (v) => v.summary.aggregate.at[3].recall
  const beats = (v) => score(v) > base + 1e-9 && paired(v, ref).better > paired(v, ref).worse
  const byAxis = (axis) => variants.filter((v) => v.name !== 'B0' && (all[v.name]?.axis ?? v.meta.axis) === axis && beats(v)).sort((a, b) => score(b) - score(a) || b.summary.aggregate.mrr - a.summary.aggregate.mrr)
  const winners = [byAxis('embedding')[0], byAxis('chunking')[0], ...byAxis('preparation'), ...byAxis('fusion'), byAxis('fts')[0]].filter(Boolean)
  if (!winners.length) return null
  const env = Object.assign({}, ...winners.map((v) => all[v.name]?.env ?? {}))
  if (env.EMBEDDING_MODEL && !env.EMBEDDING_MODEL.startsWith('EMBEDDINGGEMMA')) { delete env.EMBED_PREFIX; delete env.EMBED_DIMS }
  return { axis: 'combined', change: `winners merged: ${winners.map((v) => v.name).join(' + ')}`, env, winners: winners.map((v) => v.name) }
}

// ---- tables
const mdTable = (headers, rows) => [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n')
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const cellClass = (cell) => {
  const s = String(cell ?? '')
  const m = s.match(/\(([+−-]\d+|±0)\)$/)
  const tone = m ? (m[1].startsWith('+') ? 'up' : m[1] === '±0' ? '' : 'down') : ''
  return `${/^[\d.+−-]|^n\/a|%|MB|KB|ms| s$/.test(s) ? 'num' : ''} ${tone}`.trim()
}
const htmlTable = (headers, rows) => `<div class="wrap"><table><thead><tr>${headers.map((h, i) => `<th class="${i === 0 ? '' : 'num'}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((c, i) => `<td class="${i === 0 ? 'label' : cellClass(c)}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`

export const buildRetrievalExpReport = async (dir) => {
  const variants = await loadVariants(dir)
  if (!variants.length) throw new Error(`${dir}: no variant-*.json`)
  const ref = variants[0]
  const ks = ref.summary.k_list
  const withDelta = (v, base) => (v === ref ? pct(base) : `${pct(base)}`)
  const cell = (variant, value, baseValue) => (variant === ref ? pct(value) : `${pct(value)} (${pp(value, baseValue)})`)

  const variantHeaders = ['variant', 'axis', 'change', 'chunks', 'index', 'model', 'model MB', 'ingest', 'embed tok/s', 'load ms', 'run s']
  const variantRows = variants.map((v) => {
    const s = v.summary
    return [v.name, v.meta.axis ?? '', v.meta.change ?? '', String(s.index.chunks), kb(s.index.bytes), s.model.id, mb(s.model.bytes), s.ingest ? sec(s.ingest.ingest_ms) : 'kept', s.ingest?.embed_tps ? num(s.ingest.embed_tps) : 'n/a', num(s.model.load_ms), num(v.meta.seconds, 1)]
  })

  const kHeaders = ['variant', ...ks.map((k) => `@${k}`)]
  const recallRows = variants.map((v) => [v.name, ...ks.map((k) => cell(v, v.summary.aggregate.at[k].recall, ref.summary.aggregate.at[k].recall))])
  const precisionRows = variants.map((v) => [v.name, ...ks.map((k) => cell(v, v.summary.aggregate.at[k].precision, ref.summary.aggregate.at[k].precision))])
  const hitRows = variants.map((v) => [v.name, ...ks.map((k) => cell(v, v.summary.aggregate.at[k].hit, ref.summary.aggregate.at[k].hit))])

  const summaryHeaders = ['variant', 'recall@3', 'MRR@10', 'queries up / down vs B0 (recall@3)', 'sign test p', 'retrieval ms p50 / p95', 'embed ms p50', 'search ms p50']
  const summaryRows = variants.map((v) => {
    const a = v.summary.aggregate
    const pr = v === ref ? null : paired(v, ref)
    return [v.name, cell(v, a.at[3].recall, ref.summary.aggregate.at[3].recall), v === ref ? num(a.mrr, 3) : `${num(a.mrr, 3)} (${(a.mrr - ref.summary.aggregate.mrr) >= 0 ? '+' : ''}${num(a.mrr - ref.summary.aggregate.mrr, 3)})`, pr ? `+${pr.better} / −${pr.worse}` : '—', pr ? num(pr.p, 3) : '—', `${num(a.retrieval_ms_p50)} / ${num(a.retrieval_ms_p95)}`, num(a.embed_ms_p50), num(a.search_ms_p50)]
  })

  const sliceHeaders = ['recall@3 slice (n)', ...variants.map((v) => v.name)]
  const sliceRows = [
    ...sliceDefs.filter((def) => ref.turns.some(def[1])).map((def) => [`${def[0]} (${ref.turns.filter(def[1]).length})`, ...variants.map((v) => cell(v, sliceValue(v, def), sliceValue(ref, def)))]),
    ...goldGroups.map((def) => [`${def[0]} (${ref.turns.flatMap((t) => t.gold.filter(def[1])).length} pairs)`, ...variants.map((v) => cell(v, goldValue(v, def), goldValue(ref, def)))]),
  ]

  const canaryHeaders = ['canary · gold file', ...variants.map((v) => v.name)]
  const canaryRows = CANARIES.flatMap((id) => {
    const t = ref.turns.find((x) => x.id === id)
    if (!t) return []
    return t.gold.map((file, i) => [`${i === 0 ? `${id} «${t.query.length > 60 ? `${t.query.slice(0, 57)}…` : t.query}» · ` : '↳ '}${file}`, ...variants.map((v) => { const r = v.turns.find((x) => x.id === id)?.gold_ranks?.find((g) => g.file === file)?.rank; return r ? String(r) : '>10' })])
  })

  const diffHeaders = ['query', 'gold', ...variants.map((v) => v.name)]
  const diffRows = ref.turns.filter((t) => variants.some((v) => { const o = v.turns.find((x) => x.id === t.id); return o && Math.abs((recallAt(o, 3) ?? 0) - (recallAt(t, 3) ?? 0)) > 1e-9 }))
    .map((t) => [`${t.id} ${t.query.length > 70 ? `${t.query.slice(0, 67)}…` : t.query}`, t.gold.map((g) => g.split('/').pop()).join(', '), ...variants.map((v) => { const o = v.turns.find((x) => x.id === t.id); return o ? pct(recallAt(o, 3)) : 'n/a' })])

  // ---- decision text
  const SINGLE_AXES = ['embedding', 'chunking', 'preparation', 'fusion', 'fts', 'history', 'history-mode', 'history-gate']
  // eval_only variants (an oracle that reads the case label) are ceilings, not candidates.
  const deployable = (v) => !v.meta.eval_only
  const axisOf = (v) => v.meta.axis ?? ''
  const r3 = (v) => v.summary.aggregate.at[3].recall
  const mrr = (v) => v.summary.aggregate.mrr
  const envKeys = (v) => Object.keys(v.summary.env ?? {}).filter((k) => k !== 'LANCE_DB_DIR')
  const envText = (v) => envKeys(v).map((k) => `${k}=${v.summary.env[k]}`).join(' ') || '(defaults)'
  const dpp = (a, b) => { const d = Math.round((a - b) * 100); return `${d >= 0 ? '+' : ''}${d} pp` }
  const singles = variants.filter((v) => v !== ref && deployable(v) && SINGLE_AXES.includes(axisOf(v)))
  const bestSingle = [...singles].sort((a, b) => r3(b) - r3(a) || mrr(b) - mrr(a))[0]
  const best = variants.find((v) => v.name === 'BEST')
  const baseR3 = r3(ref)
  const lines = []
  if (bestSingle) {
    const pr = paired(bestSingle, ref)
    lines.push(`Best single change: ${bestSingle.name} (${bestSingle.meta.change ?? ''}) at recall@3 ${pct(r3(bestSingle))} (${dpp(r3(bestSingle), baseR3)}), MRR ${num(mrr(bestSingle), 3)}, ${pr.better} queries up / ${pr.worse} down (sign test p = ${num(pr.p, 3)}).`)
  }
  for (const v of singles.filter((x) => x.meta.control)) {
    const c = variants.find((x) => x.name === v.meta.control)
    if (c) lines.push(`${v.name} against its control ${c.name} (same chunking, production model): recall@3 ${pct(r3(v))} vs ${pct(r3(c))}, MRR ${num(mrr(v), 3)} vs ${num(mrr(c), 3)}, retrieval p50 ${num(v.summary.aggregate.retrieval_ms_p50)} vs ${num(c.summary.aggregate.retrieval_ms_p50)} ms, model ${mb(v.summary.model.bytes)} vs ${mb(c.summary.model.bytes)}.`)
  }
  if (best) {
    const pr = paired(best, ref)
    const over = bestSingle ? Math.round((r3(best) - r3(bestSingle)) * 100) : 0
    lines.push(`BEST (${best.meta.change ?? ''}): recall@3 ${pct(r3(best))} (${dpp(r3(best), baseR3)} vs B0, ${over >= 0 ? '+' : ''}${over} pp vs the best single), MRR ${num(mrr(best), 3)}, ${pr.better} up / ${pr.worse} down. ${over < 0 ? 'The winners are not additive: BEST is below the best single change.' : 'The winners add up.'}`)
  }
  const ablations = variants.filter((v) => axisOf(v) === 'ablation')
  if (ablations.length && best) {
    lines.push(`Ablations against BEST (${pct(r3(best))} / MRR ${num(mrr(best), 3)}): ${ablations.map((v) => `${v.name} ${pct(r3(v))} / ${num(mrr(v), 3)} (${v.meta.change ?? ''})`).join('; ')}.`)
  }
  const sweeps = variants.filter((v) => axisOf(v) === 'fusion-sweep')
  const ceilings = variants.filter((v) => v.meta.eval_only)
  if (ceilings.length) lines.push(`Ceilings (eval-only, read the case label): ${ceilings.map((v) => `${v.name} ${pct(r3(v))} / ${num(mrr(v), 3)} (${v.meta.change ?? ''})`).join('; ')}.`)
  if (sweeps.length) lines.push(`Sweeps: ${sweeps.map((v) => `${v.name} ${pct(r3(v))} / ${num(mrr(v), 3)} (${v.meta.change ?? ''})`).join('; ')}.`)
  // Recommendation: the smallest configuration whose recall@3 is within 1 pp
  // and whose MRR is within 0.015 of the best measured; ties go to the higher MRR.
  const maxR3 = Math.max(...variants.filter(deployable).map(r3))
  const maxMrr = Math.max(...variants.filter(deployable).map(mrr))
  const candidates = variants.filter((v) => deployable(v) && r3(v) >= maxR3 - 0.01 - 1e-9 && mrr(v) >= maxMrr - 0.015 - 1e-9).sort((a, b) => envKeys(a).length - envKeys(b).length || mrr(b) - mrr(a))
  const pick = candidates[0]
  if (pick) {
    const d = (r3(pick) - baseR3) * 100
    const worstSlice = Math.min(...sliceDefs.filter((def) => ref.turns.filter(def[1]).length >= 20).map((def) => (sliceValue(pick, def) ?? 0) - (sliceValue(ref, def) ?? 0)), ...goldGroups.filter((def) => ref.turns.flatMap((t) => t.gold.filter(def[1])).length >= 20).map((def) => (goldValue(pick, def) ?? 0) - (goldValue(ref, def) ?? 0))) * 100
    lines.push(pick === ref
      ? `Recommendation: keep B0; nothing beats it beyond noise.`
      : d >= 4
        ? `Recommendation: ${pick.name} — ${envText(pick)} — recall@3 ${pct(r3(pick))} (+${d.toFixed(0)} pp), MRR ${num(mrr(pick), 3)}; the smallest configuration within 1 pp / 0.015 MRR of the best measured (${candidates.slice(1, 4).map((v) => v.name).join(', ') || 'no runner-up'}). Worst slice with ≥ 20 items: ${worstSlice >= 0 ? '+' : ''}${worstSlice.toFixed(0)} pp.${d >= 4 && worstSlice > -4 ? ' Clears the 4 pp bar of the plan.' : ''}`
        : `Recommendation: keep B0 as the default; the best gain is ${d.toFixed(0)} pp, under the 4 pp bar (SE ≈ 3.3 pp at n = ${ref.turns.length}).`)
  }

  const title = `Retrieval experiment · ${variants.length} variants · ${ref.turns.length} queries · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
  const intro = `Reference is ${ref.name}; every other cell shows the value and, in brackets, the difference in percentage points. One search(query, k) per k; recall@k = share of the gold files among the top-k chunks, precision@k = share of the top-k chunks from a gold file, MRR over the top-10. No LLM: embed() plus LanceDB only.`
  const md = [
    `# ${title}`, '', intro, '',
    '## Decision', '', ...lines.map((l) => `- ${l}`), '',
    '## Variants', '', mdTable(variantHeaders, variantRows), '',
    '## recall@k', '', mdTable(kHeaders, recallRows), '',
    '## precision@k', '', mdTable(kHeaders, precisionRows), '',
    '## hit@k', '', mdTable(kHeaders, hitRows), '',
    '## Summary, cost and paired comparison', '', mdTable(summaryHeaders, summaryRows), '',
    'retrieval ms = query embedding + LanceDB search at k = 10, one embedding per query. Sign test: two-sided, on the queries whose recall@3 moved.', '',
    '## Slices (recall@3; gold rows = share of (query, gold file) pairs found in the top 3)', '', mdTable(sliceHeaders, sliceRows), '',
    '## Canaries (rank of each gold file in the top 10)', '', canaryRows.length ? mdTable(canaryHeaders, canaryRows) : 'none', '',
    `## Queries whose recall@3 differs from ${ref.name} in any variant (${diffRows.length})`, '', diffRows.length ? mdTable(diffHeaders, diffRows) : 'none', '',
  ].join('\n')

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Retrieval experiment</title>
<style>
  :root { --ink: #1c1c1c; --muted: #666; --line: #ddd; --ok: #1a7f37; --bad: #b3261e; --bg: #fff; --alt: #f6f6f6; }
  body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); margin: 0; padding: 24px 16px 64px; max-width: 1400px; margin-inline: auto; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 32px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
  .sub { color: var(--muted); margin-bottom: 16px; } .decision li { margin: 4px 0; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 12px; font-size: 13px; } th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; } th { background: var(--alt); font-weight: 600; white-space: nowrap; position: sticky; top: 0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; } td.label { white-space: nowrap; }
  .up { color: var(--ok); } .down { color: var(--bad); }
  .wrap { overflow-x: auto; } .small { font-size: 12px; color: var(--muted); }
</style></head><body>
<h1>${esc(title)}</h1>
<div class="sub">${esc(intro)} Green = better than ${esc(ref.name)}, red = worse (for precision and recall alike).</div>
<h2>Decision</h2><ul class="decision">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
<h2>Variants</h2>${htmlTable(variantHeaders, variantRows)}
<h2>recall@k</h2>${htmlTable(kHeaders, recallRows)}
<h2>precision@k</h2>${htmlTable(kHeaders, precisionRows)}
<h2>hit@k</h2>${htmlTable(kHeaders, hitRows)}
<h2>Summary, cost and paired comparison</h2>${htmlTable(summaryHeaders, summaryRows)}
<p class="small">retrieval ms = query embedding + LanceDB search at k = 10, one embedding per query. Sign test: two-sided, on the queries whose recall@3 moved.</p>
<h2>Slices (recall@3; gold rows = share of (query, gold file) pairs found in the top 3)</h2>${htmlTable(sliceHeaders, sliceRows)}
<h2>Canaries (rank of each gold file in the top 10)</h2>${canaryRows.length ? htmlTable(canaryHeaders, canaryRows) : '<p>none</p>'}
<h2>Queries whose recall@3 differs from ${esc(ref.name)} in any variant (${diffRows.length})</h2>${diffRows.length ? htmlTable(diffHeaders, diffRows) : '<p>none</p>'}
</body></html>
`
  await writeFile(join(dir, 'compare.md'), md)
  await writeFile(join(dir, 'compare.html'), html)
  return [join(dir, 'compare.md'), join(dir, 'compare.html')]
}
