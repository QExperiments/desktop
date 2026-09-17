// Per-request numbers, computed from the SDK's completionStats of every round
// plus the server's own timers. Pure: no SDK, so it is unit-tested in CI.

const sum = (rounds, key) => rounds.reduce((total, round) => total + (round.stats?.[key] ?? 0), 0)
const round1 = (value, digits = 1) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null)

// OpenAI's `usage` block plus our `stats`. The SDK reports, per round, the
// prompt tokens it processed (`promptTokens`) and the ones the KV cache
// supplied (`cacheTokens`); OpenAI counts both as prompt tokens, with the
// cached part under prompt_tokens_details. Sums run over the rounds of the
// tool loop. cache_ratio near 1 on turn two means the session's history was
// not prefilled again. ttft comes from the first round, tps is the decode rate
// over every round, prefill_tps is the first round's processed tokens per
// second before its first token.
export const summarize = ({ startedAt, retrievalMs = 0, rounds = [], rss = null, now = Date.now() }) => {
  const processed = sum(rounds, 'promptTokens')
  const generated = sum(rounds, 'generatedTokens')
  const cached = sum(rounds, 'cacheTokens')
  const promptTokens = processed + cached
  const decodeSeconds = rounds.reduce((total, round) => {
    const { generatedTokens = 0, tokensPerSecond = 0 } = round.stats ?? {}
    return tokensPerSecond > 0 ? total + generatedTokens / tokensPerSecond : total
  }, 0)
  const toolCalls = rounds.flatMap((round) => round.toolCalls ?? [])
  const ttft = rounds[0]?.stats?.timeToFirstToken ?? null
  const fresh = rounds[0]?.stats?.promptTokens ?? 0

  return {
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: generated,
      total_tokens: promptTokens + generated,
      prompt_tokens_details: { cached_tokens: cached },
    },
    stats: {
      prefill_tokens: processed,
      ttft_ms: round1(ttft),
      tps: decodeSeconds > 0 ? round1(generated / decodeSeconds) : null,
      prefill_tps: ttft > 0 ? round1(fresh / (ttft / 1000), 0) : null,
      cache_ratio: promptTokens > 0 ? round1(cached / promptTokens, 3) : null,
      total_ms: now - startedAt,
      retrieval_ms: retrievalMs,
      tool_ms: toolCalls.reduce((total, call) => total + (call.ms ?? 0), 0),
      rounds: rounds.length,
      tool_calls: toolCalls,
      backend: rounds[0]?.stats?.backendDevice ?? null,
      rss,
    },
  }
}
