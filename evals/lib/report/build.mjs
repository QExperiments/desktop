import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// One self-contained report.html (data inlined, no CDN) plus a report.md
// with the headline tables, from the files of one results directory.

const readJsonl = async (path) => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

const gb = (bytes) => (Number.isFinite(bytes) ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : 'n/a')
const pct = (value) => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'n/a')
const num = (value, digits = 0) => (Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a')
const ms = (value) => (Number.isFinite(value) ? `${Math.round(value)} ms` : 'n/a')

const mdTable = (headers, rows) => [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n')

export const buildMarkdown = (m) => {
  const h = m.header ?? {}
  const parts = [`# Eval report ${h.ts ?? ''}`, '']
  parts.push(mdTable(['Machine', 'Tier', 'Chat model', 'Runs', 'Cold start', 'Turns', 'Errors'], [[
    `${h.hardware?.cpu ?? '?'}, ${gb(h.hardware?.totalBytes)}, ${h.hardware?.backend ?? '?'}`, h.tier ?? '?', h.chatModel ?? '?', h.runs ?? '?', ms(h.coldStartMs), m.latency?.n ?? 0, m.latency?.errors ?? 0,
  ]]), '')
  parts.push('## Latency (all live turns)', '', mdTable(['ttft p50', 'ttft p95', 'tps p50', 'total p50', 'total p95', 'prefill tps p50', 'cache ratio', 'prompt tokens', 'completion tokens'], [[
    ms(m.latency?.ttft_p50), ms(m.latency?.ttft_p95), num(m.latency?.tps_p50, 1), ms(m.latency?.total_p50), ms(m.latency?.total_p95), num(m.latency?.prefill_tps_p50), num(m.latency?.cache_ratio_mean, 2), num(m.latency?.prompt_tokens_mean), num(m.latency?.completion_tokens_mean),
  ]]), '')
  if (m.retrieval) parts.push('## Retrieval', '', mdTable(['n', 'recall@k', 'precision@k', 'MRR', 'hit@1', 'retrieval ms p50'], [[m.retrieval.n, pct(m.retrieval.recall_at_k), pct(m.retrieval.precision_at_k), num(m.retrieval.mrr, 2), pct(m.retrieval.hit_at_1), ms(m.retrieval.retrieval_ms_p50)]]), '')
  if (m.single) {
    const s = m.single
    parts.push('## Single', '', mdTable(['n', 'must', 'number match', 'grounded', 'citation precision', 'lang', 'empty', 'leak', 'false abstain'], [[s.n, pct(s.must_rate), pct(s.number_match_mean), pct(s.grounded_rate), pct(s.citation_precision_mean), pct(s.lang_rate), pct(s.empty_rate), pct(s.leak_rate), pct(s.abstained_rate)]]), '')
    if (s.judge) parts.push(mdTable(['judge n', 'parse ok', 'faithfulness', 'hallucination', 'evidence verified', 'answered', 'correct', 'kappa', 'ms/verdict'], [[s.judge.n, pct(s.judge.parse_ok_rate), pct(s.judge.faithfulness_mean), pct(s.judge.hallucination_rate), pct(s.judge.evidence_verified_mean), JSON.stringify(s.judge.answered), JSON.stringify(s.judge.correct), s.judge.kappa ? JSON.stringify(s.judge.kappa) : 'no labels', num(s.judge.ms_mean)]]), '')
  }
  if (m.abstain) parts.push('## Abstain', '', mdTable(['n', 'abstained', 'tool called', 'grounded', 'by kind', 'abstention precision', 'abstention recall'], [[m.abstain.n, pct(m.abstain.abstained_rate), pct(m.abstain.tool_called_rate), pct(m.abstain.grounded_rate), JSON.stringify(m.abstain.by_kind), pct(m.abstention?.precision), pct(m.abstention?.recall)]]), '')
  if (m.tools) {
    const t = m.tools
    parts.push('## Tools', '', mdTable(['n', 'routing P', 'routing R', 'tp/wrong/fp/fn/tn', 'args match', 'wrong tool', 'must', 'rounds', 'repeat calls', 'limit hits', 'tool errors'], [[t.n, pct(t.routing.precision), pct(t.routing.recall), `${t.routing.tp}/${t.routing.wrong}/${t.routing.fp}/${t.routing.fn}/${t.routing.tn}`, pct(t.args_subset_rate), pct(t.wrong_tool_rate), pct(t.must_rate), num(t.rounds_mean, 2), t.repeat_calls, t.limit_hits, t.tool_errors]]), '')
  }
  if (m.memory) parts.push('## Memory', '', mdTable(['sessions', 'recalls', 'memory overall', 'from memory', 're-fetched', 'by d'], [[m.memory.n_sessions, m.memory.n_recalls, pct(m.memory.memory_overall), pct(m.memory.recalled_from_memory), pct(m.memory.re_fetched), m.memory.by_d.map((d) => `d=${d.d}: ${pct(d.rate)} (${d.n})`).join(', ')]]), '')
  if (m.multiturn) parts.push('## Multiturn', '', mdTable(['sessions', 'followup resolution', 'consistency', 'must', 'routing P', 'routing R'], [[m.multiturn.n_sessions, pct(m.multiturn.followup_resolution), pct(m.multiturn.consistency), pct(m.multiturn.must_rate), pct(m.multiturn.routing?.precision), pct(m.multiturn.routing?.recall)]]), '')
  if (m.stress) {
    parts.push('## Stress', '', mdTable(['session', 'turns', 'errors', 'empty', 'ttft p50/p95', 'tps p50', 'ttft slope ms/turn', 'rss peak', 'rss slope B/s', 'ctx hit'], m.stress.sessions.map((s) => [`${s.id} r${s.run}`, s.turns, pct(s.error_rate), pct(s.empty_rate), `${ms(s.ttft_p50)} / ${ms(s.ttft_p95)}`, num(s.tps_p50, 1), num(s.ttft_slope_ms_per_turn, 1), gb(s.memory.rss_tree_peak), num(s.memory.rss_tree_slope_bps), s.ctx_hit_turn ? `turn ${s.ctx_hit_turn.turn} (${s.ctx_hit_turn.what})` : 'none'])), '')
  }
  if (m.hardware) {
    parts.push('## Hardware by phase', '', mdTable(['phase', 'samples', 'rss tree peak', 'rss bare peak', 'system used mean', 'cpu %', 'gpu %'], Object.entries(m.hardware.phases).map(([phase, p]) => [phase, p.samples, gb(p.rss_tree_peak), gb(p.rss_bare_peak), gb(p.system_used_mean), num(p.cpu_mean), num(p.gpu_util_mean)])), '')
    parts.push(`System memory used: +${gb(m.hardware.system_used_delta_load)} after load, ${gb(m.hardware.system_used_delta_after_unload)} above base after unload.`, '')
  }
  return parts.join('\n')
}

export const buildReport = async (dir) => {
  const metrics = await readJson(join(dir, 'metrics.json'))
  const turns = await readJsonl(join(dir, 'turns.jsonl'))
  const verdicts = await readJsonl(join(dir, 'verdicts.jsonl'))
  const hardware = await readJsonl(join(dir, 'hardware.jsonl'))
  const template = await readFile(new URL('./template.html', import.meta.url), 'utf8')
  // Answers and traces stay on this disk; the report is meant to be opened here.
  const data = JSON.stringify({ metrics, turns, verdicts, hardware }).replace(/<\/script/gi, '<\\/script')
  const html = template.replace('__TITLE__', `Eval ${metrics.header?.ts ?? ''} · tier ${metrics.header?.tier ?? ''}`).replace('__DATA__', data)
  await writeFile(join(dir, 'report.html'), html)
  await writeFile(join(dir, 'report.md'), buildMarkdown(metrics))
  return { html: join(dir, 'report.html'), md: join(dir, 'report.md') }
}
