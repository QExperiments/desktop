// Per-request numbers, computed from the SDK's completionStats of every round
// plus the server's own timers. Pure: no SDK, so it is unit-tested in CI.

const sum = (rounds, key) => rounds.reduce((total, round) => total + (round.stats?.[key] ?? 0), 0)
const round1 = (value, digits = 1) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null)

// What a round's `cacheTokens` actually is: the addon documents it as "Final
// cache tokens", the size of the live KV when the round ended. It therefore
// already contains the tokens this round prefilled and the ones it generated
// -- on the first turn of a session, with nothing to reuse, it is still
// larger than `promptTokens`. What the round reused is what stood in the KV
// before it ran, so that is what OpenAI's cached_tokens wants:
//
//   reused = cacheTokens - promptTokens - generatedTokens
//
// Until 2026-09-21 this file added `cacheTokens` to `promptTokens` instead,
// which counted the round's own prompt and answer a second time and put
// `context_tokens` above `ctx_size` -- physically impossible.
const reused = (stats) =>
  Math.max(0, (stats?.cacheTokens ?? 0) - (stats?.promptTokens ?? 0) - (stats?.generatedTokens ?? 0))

// The live context at the end of a round. With a KV file the addon reports
// it; without one (no cache key) the sequence still held the prompt and the
// answer.
const held = (stats) =>
  (stats?.cacheTokens ?? 0) || ((stats?.promptTokens ?? 0) + (stats?.generatedTokens ?? 0))

// OpenAI's `usage` block plus our `stats`. The SDK reports, per round, the
// prompt tokens it processed (`promptTokens`) and the size of the KV at the
// end (`cacheTokens`); OpenAI counts processed plus reused as prompt tokens,
// with the reused part under prompt_tokens_details. Sums run over the rounds of the
// tool loop. cache_ratio near 1 on turn two means the session's history was
// not prefilled again. ttft comes from the first round, tps is the decode rate
// over every round, prefill_tps is the first round's processed tokens per
// second before its first token. `rewrite` (MERIDIAN_QUERY_REWRITE=1, ADR-012)
// is the query-rewrite completion of this turn: its tokens count in `usage`
// like the rounds do, and stand alone in stats.rewrite_tokens; prefill_tokens,
// context_tokens, ttft and prefill_tps describe the answer path only.
export const summarize = ({ startedAt, retrievalMs = 0, rounds = [], rewrite = null, rss = null, now = Date.now() }) => {
  const processed = sum(rounds, 'promptTokens')
  const generated = sum(rounds, 'generatedTokens')
  const cached = rounds.reduce((total, round) => total + reused(round.stats), 0)
  const promptTokens = processed + cached
  const decodeSeconds = rounds.reduce((total, round) => {
    const { generatedTokens = 0, tokensPerSecond = 0 } = round.stats ?? {}
    return tokensPerSecond > 0 ? total + generatedTokens / tokensPerSecond : total
  }, 0)
  const toolCalls = rounds.flatMap((round) => round.toolCalls ?? [])
  // usage sums the rounds like separate API calls would; the context the
  // model actually held is the largest live KV any single round ended with,
  // which `ctx_size` bounds.
  const contextTokens = rounds.reduce((max, round) => Math.max(max, held(round.stats)), 0)
  const ttft = rounds[0]?.stats?.timeToFirstToken ?? null
  const fresh = rounds[0]?.stats?.promptTokens ?? 0
  const rewritePrompt = (rewrite?.stats?.promptTokens ?? 0) + reused(rewrite?.stats)
  const rewriteGenerated = rewrite?.stats?.generatedTokens ?? 0

  return {
    usage: {
      prompt_tokens: promptTokens + rewritePrompt,
      completion_tokens: generated + rewriteGenerated,
      total_tokens: promptTokens + rewritePrompt + generated + rewriteGenerated,
      prompt_tokens_details: { cached_tokens: cached + reused(rewrite?.stats) },
    },
    stats: {
      prefill_tokens: processed,
      context_tokens: contextTokens,
      ttft_ms: round1(ttft),
      tps: decodeSeconds > 0 ? round1(generated / decodeSeconds) : null,
      prefill_tps: ttft > 0 ? round1(fresh / (ttft / 1000), 0) : null,
      cache_ratio: promptTokens > 0 ? round1(cached / promptTokens, 3) : null,
      total_ms: now - startedAt,
      retrieval_ms: retrievalMs,
      rewrite_ms: rewrite ? rewrite.ms ?? null : null,
      rewrite_tokens: rewrite ? rewritePrompt + rewriteGenerated : null,
      tool_ms: toolCalls.reduce((total, call) => total + (call.ms ?? 0), 0),
      rounds: rounds.length,
      tool_calls: toolCalls,
      backend: rounds[0]?.stats?.backendDevice ?? null,
      rss,
    },
  }
}
