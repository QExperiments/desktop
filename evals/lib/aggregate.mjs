import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { kappa } from './judge/judge.mjs'
import { aggregateMemory, scoreMemory } from './metrics/memory.mjs'
import { aggregateRetrievalTurns } from './metrics/retrieval-turn.mjs'
import { aggregateMultiturn, scoreMultiturn } from './metrics/multiturn.mjs'
import { aggregateRetrieval, percentile } from './metrics/retrieval.mjs'
import { memoryTrend, scoreStress } from './metrics/stress.mjs'
import { routingPR, toolStats } from './metrics/tools.mjs'

// From the raw rows of a run (turns, verdicts, hardware ticks) to the
// aggregates the report prints. Pure functions over JSON; reused by
// --report-only.

const mean = (values) => {
  const known = values.filter((v) => Number.isFinite(v))
  return known.length ? Number((known.reduce((a, b) => a + b, 0) / known.length).toFixed(3)) : null
}
const rate = (values) => {
  const known = values.filter((v) => v === true || v === false)
  return known.length ? Number((known.filter(Boolean).length / known.length).toFixed(3)) : null
}
const dist = (values) => {
  const out = {}
  for (const value of values) if (value !== undefined && value !== null) out[value] = (out[value] ?? 0) + 1
  return out
}
const groupBy = (rows, key) => {
  const out = {}
  for (const row of rows) (out[key(row)] ??= []).push(row)
  return out
}

const latency = (rows) => {
  const ok = rows.filter((row) => row.status === 200 && !row.error)
  const pick = (f) => ok.map(f).filter(Number.isFinite)
  return {
    n: rows.length,
    errors: rows.length - ok.length,
    ttft_p50: percentile(pick((r) => r.stats?.ttft_ms), 0.5),
    ttft_p95: percentile(pick((r) => r.stats?.ttft_ms), 0.95),
    ttft_client_p50: percentile(pick((r) => r.ttft_client_ms), 0.5),
    tps_p50: percentile(pick((r) => r.stats?.tps), 0.5),
    total_p50: percentile(pick((r) => r.wall_ms), 0.5),
    total_p95: percentile(pick((r) => r.wall_ms), 0.95),
    prefill_tps_p50: percentile(pick((r) => r.stats?.prefill_tps), 0.5),
    cache_ratio_mean: mean(pick((r) => r.stats?.cache_ratio)),
    prompt_tokens_mean: mean(pick((r) => r.usage?.prompt_tokens)),
    completion_tokens_mean: mean(pick((r) => r.usage?.completion_tokens)),
    thinking_chars_mean: mean(pick((r) => r.thinking_chars)),
  }
}

// Tokens a turn cost, from usage (every completion of the turn, the query
// rewrite included) and stats (the answer path alone), plus the tokens one
// whole session cost; the A/B of retrieval strategies compares these.
const tokensBlock = (rows) => {
  const ok = rows.filter((row) => row.status === 200 && !row.error)
  const pick = (f) => ok.map(f).filter(Number.isFinite)
  // rows written before ADR-012 carry hits and tool_calls but not these two fields
  const freshOf = (r) => r.fresh_excerpts ?? (Array.isArray(r.hits) ? r.hits.filter((hit) => !hit.reused).length : null)
  const searchesOf = (r) => r.search_calls ?? (Array.isArray(r.tool_calls) ? r.tool_calls.filter((call) => call.name === 'search_documents').length : null)
  const sessions = Object.values(groupBy(ok, (r) => `${r.id}#${r.run}`))
  return {
    n: ok.length,
    prompt_mean: mean(pick((r) => r.usage?.prompt_tokens)),
    prefill_mean: mean(pick((r) => r.stats?.prefill_tokens)),
    cached_mean: mean(pick((r) => r.usage?.prompt_tokens_details?.cached_tokens)),
    completion_mean: mean(pick((r) => r.usage?.completion_tokens)),
    // the median too: one runaway answer of 10k+ tokens moves the mean by 100+
    completion_p50: percentile(pick((r) => r.usage?.completion_tokens), 0.5),
    completion_max: Math.max(0, ...pick((r) => r.usage?.completion_tokens)) || null,
    total_mean: mean(pick((r) => r.usage?.total_tokens)),
    context_mean: mean(pick((r) => r.context_tokens)),
    context_max: Math.max(0, ...pick((r) => r.context_tokens)) || null,
    rewrite_mean: mean(pick((r) => r.stats?.rewrite_tokens)),
    rewrite_turns: ok.filter((r) => r.rewrite).length,
    rewrite_used: rate(ok.filter((r) => r.rewrite).map((r) => r.rewrite.used === true)),
    rewrite_ms_mean: mean(pick((r) => r.stats?.rewrite_ms)),
    session_total_mean: mean(sessions.map((s) => s.reduce((sum, r) => sum + (r.usage?.total_tokens ?? 0), 0))),
    session_prefill_mean: mean(sessions.map((s) => s.reduce((sum, r) => sum + (r.stats?.prefill_tokens ?? 0), 0))),
    fresh_excerpts_mean: mean(pick(freshOf)),
    turns_with_fresh_excerpts: rate(ok.map((r) => (freshOf(r) ?? 0) > 0)),
    search_calls_per_turn: mean(pick(searchesOf)),
    turns_with_search: rate(ok.map((r) => (searchesOf(r) ?? 0) > 0)),
    retrieval_ms_mean: mean(pick((r) => r.stats?.retrieval_ms)),
  }
}

const textBlock = (rows) => ({
  must_rate: rate(rows.map((r) => r.must)),
  number_match_mean: mean(rows.map((r) => r.number_match)),
  grounded_rate: rate(rows.map((r) => r.grounded)),
  citation_precision_mean: mean(rows.map((r) => r.citation_precision)),
  citation_recall_mean: mean(rows.map((r) => r.citation_recall)),
  lang_rate: rate(rows.map((r) => r.lang)),
  empty_rate: rate(rows.map((r) => r.empty)),
  leak_rate: rate(rows.map((r) => r.leak)),
  abstained_rate: rate(rows.map((r) => r.abstained)),
})

const readLabels = async (labelsDir, category) => {
  const text = await readFile(join(labelsDir, `${category}.jsonl`), 'utf8').catch(() => '')
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
}

// Judge aggregates for one category plus agreement with the hand labels.
// A label row names the case (`id`), optionally the `run` and the `turn`, and
// the first characters of the answer it was written for (`answer_prefix`), so
// a label never scores a verdict on a different answer. Fields compared:
// whatever the label has besides those keys.
const judgeBlock = (verdicts, labels, turns = []) => {
  if (!verdicts.length) return null
  const ok = verdicts.filter((v) => v.parse_ok && v.verdict)
  const block = {
    n: verdicts.length,
    parse_ok_rate: rate(verdicts.map((v) => v.parse_ok)),
    ms_mean: mean(verdicts.map((v) => v.ms)),
    faithfulness_mean: mean(ok.map((v) => v.derived?.faithfulness)),
    hallucination_rate: rate(ok.map((v) => v.derived?.hallucination)),
    evidence_verified_mean: mean(ok.map((v) => v.derived?.evidence_verified)),
    abstain_ok_rate: rate(ok.map((v) => v.derived?.abstain_ok)),
    answered: dist(ok.map((v) => v.verdict.answered)),
    correct: dist(ok.map((v) => v.verdict.correct)),
    relevance: dist(ok.map((v) => v.verdict.relevance)),
    behaviour: dist(ok.map((v) => v.verdict.behaviour)),
    coherence: dist(ok.map((v) => v.verdict.coherence)),
    knowledge_retention: dist(ok.map((v) => v.verdict.knowledge_retention)),
    // multiquery: units whose accumulated context was cut to fit the judge
    trimmed_units: verdicts.filter((v) => v.context_trimmed > 0).length,
    // claude-cli backend only
    cost_usd: verdicts.some((v) => Number.isFinite(v.cost_usd)) ? Number(verdicts.reduce((sum, v) => sum + (v.cost_usd ?? 0), 0).toFixed(3)) : null,
    kappa: null,
  }
  const answerOf = (v) => turns.find((t) => t.category === v.category && t.id === v.id && t.run === v.run && t.turn === v.turn)?.text ?? ''
  const paired = labels.map((label) => ({
    label,
    verdict: ok.find((v) => v.id === label.id && (label.run === undefined || v.run === label.run) && (label.turn === undefined || v.turn === label.turn) && (!label.answer_prefix || answerOf(v).startsWith(label.answer_prefix))),
  })).filter((p) => p.verdict)
  if (paired.length) {
    const fields = Object.keys(labels[0]).filter((key) => !['id', 'run', 'turn', 'note', 'answer', 'answer_prefix'].includes(key))
    block.kappa = { n: paired.length }
    for (const field of fields) {
      const truth = paired.map((p) => p.label[field])
      const judged = paired.map((p) => field in (p.verdict.verdict ?? {}) ? p.verdict.verdict[field] : p.verdict.derived?.[field])
      block.kappa[field] = Number(kappa(truth, judged)?.toFixed(3))
    }
  }
  return block
}

export const aggregate = async ({ turns, verdicts, hardware, cases, config, labelsDir, header }) => {
  const by = groupBy(turns, (row) => row.category)
  const live = turns.filter((row) => row.category !== 'retrieval')
  const verdictsBy = groupBy(verdicts, (v) => v.category)
  const caseById = Object.fromEntries(Object.values(cases).flat().map((job) => [job.case.id, job.case]))

  const metrics = { header, latency: latency(live) }

  if (by.retrieval) metrics.retrieval = aggregateRetrieval(by.retrieval)

  if (by.single) {
    metrics.single = { n: by.single.length, ...textBlock(by.single), latency: latency(by.single), judge: judgeBlock(verdictsBy.single ?? [], await readLabels(labelsDir, 'single'), turns) }
  }

  if (by.abstain) {
    const rows = by.abstain
    metrics.abstain = {
      n: rows.length,
      abstained_rate: rate(rows.map((r) => r.abstained)),
      tool_called_rate: rate(rows.map((r) => (r.tool_calls ?? []).length > 0)),
      by_kind: Object.fromEntries(Object.entries(groupBy(rows, (r) => r.kind)).map(([kind, list]) => [kind, { n: list.length, abstained_rate: rate(list.map((r) => r.abstained)) }])),
      ...textBlock(rows),
      latency: latency(rows),
      judge: judgeBlock(verdictsBy.abstain ?? [], await readLabels(labelsDir, 'abstain'), turns),
    }
  }

  // Abstention as a classifier over single (should answer) and abstain (should refuse).
  if (by.single || by.abstain) {
    const tp = (by.abstain ?? []).filter((r) => r.abstained).length
    const fn = (by.abstain ?? []).filter((r) => r.abstained === false).length
    const fp = (by.single ?? []).filter((r) => r.abstained).length
    metrics.abstention = { tp, fn, fp, precision: tp + fp ? Number((tp / (tp + fp)).toFixed(3)) : null, recall: tp + fn ? Number((tp / (tp + fn)).toFixed(3)) : null }
  }

  if (by.tools) {
    const rows = by.tools
    metrics.tools = {
      n: rows.length,
      routing: routingPR(rows),
      args_subset_rate: rate(rows.map((r) => r.args_subset_match)),
      wrong_tool_rate: rate(rows.map((r) => r.wrong_tool)),
      unknown_tool_rate: rate(rows.map((r) => r.unknown_tool)),
      must_rate: rate(rows.map((r) => r.must)),
      rounds_mean: mean(rows.map((r) => r.rounds)),
      repeat_calls: rows.reduce((s, r) => s + (r.repeat_calls ?? 0), 0),
      limit_hits: rows.reduce((s, r) => s + (r.limit_hits ?? 0), 0),
      tool_errors: rows.reduce((s, r) => s + (r.tool_errors ?? 0), 0),
      ...textBlock(rows),
      latency: latency(rows),
      stats: toolStats(rows),
    }
  }

  // agentsearch: the retrieval queries put to the agent loop one turn at a
  // time. Scored with the same retrieval block as `retrieval` and
  // `multiquery`, plus what the loop itself cost: searches a turn, rounds,
  // and the files the answer ended up citing.
  if (by.agentsearch) {
    const rows = by.agentsearch
    metrics.agentsearch = {
      n: rows.length,
      ...aggregateRetrievalTurns(rows),
      searches_per_turn: mean(rows.map((r) => r.search_calls)),
      turns_with_search: rate(rows.map((r) => (r.search_calls ?? 0) > 0)),
      citations_mean: mean(rows.map((r) => (r.citations ?? []).length)),
      ...textBlock(rows),
      tokens: tokensBlock(rows),
      latency: latency(rows),
      stats: toolStats(rows),
    }
  }

  if (by.agent) {
    const rows = by.agent
    metrics.agent = {
      n_sessions: Object.keys(groupBy(rows, (r) => `${r.id}#${r.run}`)).length,
      // Scored exactly as multiquery is, so recall, precision, MRR and
      // context_recall of the two retrieval designs are one measurement.
      ...aggregateRetrievalTurns(rows),
      // What the experiment is for: the cache across the turns of one
      // conversation, next to the tool the turn was supposed to pick.
      by_turn: Object.entries(groupBy(rows, (r) => r.turn))
        .map(([turn, list]) => ({ turn: Number(turn), n: list.length, prefill: mean(list.map((r) => r.stats?.prefill_tokens)), cached: mean(list.map((r) => r.cached_tokens)), context: mean(list.map((r) => r.context_tokens)), cache_ratio: mean(list.map((r) => r.stats?.cache_ratio)), ttft: mean(list.map((r) => r.stats?.ttft_ms)) }))
        .sort((a, b) => a.turn - b.turn),
      routing: routingPR(rows.filter((r) => r.expected_tool !== undefined)),
      args_subset_rate: rate(rows.map((r) => r.args_subset_match)),
      wrong_tool_rate: rate(rows.map((r) => r.wrong_tool)),
      unknown_tool_rate: rate(rows.map((r) => r.unknown_tool)),
      compactions: rows.filter((r) => r.compacted).length,
      ...textBlock(rows),
      tokens: tokensBlock(rows),
      latency: latency(rows),
      stats: toolStats(rows),
    }
  }

  if (by.memory) {
    const scored = Object.values(groupBy(by.memory, (r) => `${r.id}#${r.run}`)).map((rows) => ({ id: rows[0].id, run: rows[0].run, ...scoreMemory(rows, caseById[rows[0].id]) }))
    metrics.memory = {
      n_sessions: scored.length,
      ...aggregateMemory(scored),
      per_case: scored,
      prompt_tokens_by_turn: Object.entries(groupBy(by.memory, (r) => r.turn)).map(([turn, rows]) => ({ turn: Number(turn), mean: mean(rows.map((r) => r.usage?.prompt_tokens)) })),
      ...textBlock(by.memory),
      latency: latency(by.memory),
      stats: toolStats(by.memory),
    }
  }

  if (by.multiturn) {
    const scored = Object.values(groupBy(by.multiturn, (r) => `${r.id}#${r.run}`)).map((rows) => ({ id: rows[0].id, run: rows[0].run, ...scoreMultiturn(rows, caseById[rows[0].id]) }))
    metrics.multiturn = {
      n_sessions: scored.length,
      ...aggregateMultiturn(scored),
      per_case: scored,
      ...textBlock(by.multiturn),
      routing: routingPR(by.multiturn.filter((r) => r.expected_tool !== undefined)),
      latency: latency(by.multiturn),
      stats: toolStats(by.multiturn),
      judge: judgeBlock(verdictsBy.multiturn ?? [], await readLabels(labelsDir, 'multiturn'), turns),
    }
  }

  if (by.multiquery) {
    const rows = by.multiquery
    const verdictsMq = verdictsBy.multiquery ?? []
    const verdictOf = (row) => verdictsMq.find((v) => v.id === row.id && v.run === row.run && v.turn === row.turn && v.parse_ok && v.verdict)
    const goldVerdicts = rows.filter((r) => r.has_gold).map(verdictOf).filter(Boolean)
    const noAnswerVerdicts = rows.filter((r) => r.has_gold === false).map(verdictOf).filter(Boolean)
    metrics.multiquery = {
      n_sessions: Object.keys(groupBy(rows, (r) => `${r.id}#${r.run}`)).length,
      ...aggregateRetrievalTurns(rows),
      context_tokens_by_turn: Object.entries(groupBy(rows, (r) => r.turn))
        .map(([turn, list]) => ({ turn: Number(turn), n: list.length, context: mean(list.map((r) => r.context_tokens)), cached: mean(list.map((r) => r.cached_tokens)), ttft: mean(list.map((r) => r.stats?.ttft_ms)) }))
        .sort((a, b) => a.turn - b.turn),
      ...textBlock(rows),
      // code's read of the turns with gold that refused anyway (the judge's `answered` is the other read)
      false_abstain_rate: rate(rows.filter((r) => r.has_gold).map((r) => r.abstained)),
      tokens: tokensBlock(rows),
      latency: latency(rows),
      stats: toolStats(rows),
      judge: judgeBlock(verdictsMq, await readLabels(labelsDir, 'multiquery'), turns),
      // The judge's read of the two kinds of turn: with gold, was the answer
      // faithful; without gold, did the assistant refuse rather than invent.
      judge_gold: goldVerdicts.length ? { n: goldVerdicts.length, faithfulness_mean: mean(goldVerdicts.map((v) => v.derived?.faithfulness)), hallucination_rate: rate(goldVerdicts.map((v) => v.derived?.hallucination)), answered: dist(goldVerdicts.map((v) => v.verdict.answered)) } : null,
      judge_no_answer: noAnswerVerdicts.length ? { n: noAnswerVerdicts.length, refused_rate: rate(noAnswerVerdicts.map((v) => v.verdict.answered === 'refused' || v.verdict.answered === 'no')), hallucination_rate: rate(noAnswerVerdicts.map((v) => v.derived?.hallucination)), answered: dist(noAnswerVerdicts.map((v) => v.verdict.answered)) } : null,
    }
  }

  if (by.stress) {
    const ctx = config.ctx?.[header.tier] ?? 16384
    const sessions = Object.values(groupBy(by.stress, (r) => `${r.id}#${r.run}`)).map((rows) => {
      const ticks = hardware.filter((h) => h.phase === 'generating' && h.case === rows[0].id && h.run === rows[0].run)
      return { id: rows[0].id, run: rows[0].run, ...scoreStress(rows, { ctx, predict: config.predict ?? 320 }), memory: memoryTrend(ticks) }
    })
    const peaks = sessions.map((s) => s.memory.rss_tree_peak).filter(Number.isFinite)
    metrics.stress = {
      n_sessions: sessions.length,
      sessions,
      rss_peak_spread: peaks.length > 1 ? Number(((Math.max(...peaks) - Math.min(...peaks)) / Math.max(...peaks)).toFixed(3)) : null,
      stats: toolStats(by.stress),
      latency: latency(by.stress),
    }
  }

  // Hardware by phase: what the fleet laptop would feel at each stage.
  const phases = groupBy(hardware, (h) => h.phase)
  metrics.hardware = {
    phases: Object.fromEntries(Object.entries(phases).map(([phase, rows]) => [phase, {
      samples: rows.length,
      rss_tree_peak: Math.max(0, ...rows.map((r) => r.rss_tree ?? 0)) || null,
      rss_tree_mean: mean(rows.map((r) => r.rss_tree)),
      rss_bare_peak: Math.max(0, ...rows.map((r) => r.rss_bare ?? 0)) || null,
      footprint_bare_peak: Math.max(0, ...rows.map((r) => r.footprint_bare ?? 0)) || null,
      footprint_bare_mean: mean(rows.map((r) => r.footprint_bare)),
      system_used_mean: mean(rows.map((r) => r.system_used)),
      system_used_peak: Math.max(0, ...rows.map((r) => r.system_used ?? 0)) || null,
      cpu_mean: mean(rows.map((r) => r.cpu)),
      gpu_util_mean: mean(rows.map((r) => r.gpu_util)),
    }])),
    system_used_delta_load: (() => {
      const before = mean((phases.before_load ?? []).map((r) => r.system_used))
      const idle = mean((phases.loaded_idle ?? []).map((r) => r.system_used))
      return before !== null && idle !== null ? idle - before : null
    })(),
    system_used_delta_after_unload: (() => {
      const before = mean((phases.before_load ?? []).map((r) => r.system_used))
      const after = mean((phases.after_unload ?? []).map((r) => r.system_used))
      return before !== null && after !== null ? after - before : null
    })(),
  }

  return metrics
}
