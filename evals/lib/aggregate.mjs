import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { kappa } from './judge/judge.mjs'
import { aggregateMemory, scoreMemory } from './metrics/memory.mjs'
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

const textBlock = (rows) => ({
  must_rate: rate(rows.map((r) => r.must)),
  number_match_mean: mean(rows.map((r) => r.number_match)),
  grounded_rate: rate(rows.map((r) => r.grounded)),
  citation_precision_mean: mean(rows.map((r) => r.citation_precision)),
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
// A label row names the case (`id`), optionally the `run`, and the first
// characters of the answer it was written for (`answer_prefix`), so a label
// never scores a verdict on a different answer. Fields compared: whatever
// the label has besides those keys.
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
    kappa: null,
  }
  const answerOf = (v) => turns.find((t) => t.category === v.category && t.id === v.id && t.run === v.run && t.turn === v.turn)?.text ?? ''
  const paired = labels.map((label) => ({
    label,
    verdict: ok.find((v) => v.id === label.id && (label.run === undefined || v.run === label.run) && (!label.answer_prefix || answerOf(v).startsWith(label.answer_prefix))),
  })).filter((p) => p.verdict)
  if (paired.length) {
    const fields = Object.keys(labels[0]).filter((key) => !['id', 'run', 'note', 'answer', 'answer_prefix'].includes(key))
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
