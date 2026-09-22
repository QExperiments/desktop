import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarize } from '../../src/chat/stats.js'

const round = (stats, toolCalls = []) => ({ stats, toolCalls })

test('sums tokens over the tool loop and takes ttft from the first round', () => {
  const { usage, stats } = summarize({
    startedAt: 1000,
    now: 4000,
    retrievalMs: 120,
    rounds: [
      // cacheTokens is the live KV at the END of the round, so it already
      // holds that round's 900 processed and 40 generated: 1700 - 940 = 760
      // stood there before it ran.
      round({ promptTokens: 900, cacheTokens: 1700, generatedTokens: 40, timeToFirstToken: 400, tokensPerSecond: 80, backendDevice: 'gpu' }, [{ name: 'lookup_stock', args: { sku: 'SD-X4-001' }, ms: 5 }]),
      round({ promptTokens: 1000, cacheTokens: 2820, generatedTokens: 60, timeToFirstToken: 150, tokensPerSecond: 60 }),
    ],
  })
  // processed 900 + 1000 plus reused 760 + 1760 are all prompt tokens to OpenAI
  assert.deepEqual(usage, { prompt_tokens: 4420, completion_tokens: 100, total_tokens: 4520, prompt_tokens_details: { cached_tokens: 2520 } })
  assert.equal(stats.prefill_tokens, 1900)
  // the live KV the second round ended with
  assert.equal(stats.context_tokens, 2820)
  assert.equal(stats.ttft_ms, 400)
  assert.equal(stats.rounds, 2)
  assert.equal(stats.total_ms, 3000)
  assert.equal(stats.retrieval_ms, 120)
  assert.equal(stats.tool_ms, 5)
  assert.equal(stats.cache_ratio, 0.57)
  // 900 prompt tokens processed in 0.4 s before the first token
  assert.equal(stats.prefill_tps, 2250)
  // 40 tokens at 80 tok/s + 60 tokens at 60 tok/s = 100 tokens in 1.5 s
  assert.equal(stats.tps, 66.7)
  assert.equal(stats.backend, 'gpu')
  assert.deepEqual(stats.tool_calls.map((call) => call.name), ['lookup_stock'])
})

test('survives a round without stats', () => {
  const { usage, stats } = summarize({ startedAt: 0, now: 10, rounds: [round(null)] })
  assert.equal(usage.total_tokens, 0)
  assert.equal(stats.ttft_ms, null)
  assert.equal(stats.tps, null)
  assert.equal(stats.cache_ratio, null)
  assert.equal(stats.prefill_tps, null)
})

test('a query rewrite counts in usage and stands alone in stats, the answer path keeps its own numbers', () => {
  const { usage, stats } = summarize({
    startedAt: 0,
    now: 2000,
    retrievalMs: 100,
    rewrite: { from: 'and the extended one?', to: 'ServoDrive X4 extended warranty', used: true, ms: 350, stats: { promptTokens: 210, cacheTokens: 0, generatedTokens: 9 } },
    rounds: [round({ promptTokens: 400, cacheTokens: 2050, generatedTokens: 50, timeToFirstToken: 200, tokensPerSecond: 100 })],
  })
  // 2050 - 400 - 50 = 1600 reused, and the rewrite ran without a cache
  assert.deepEqual(usage, { prompt_tokens: 2210, completion_tokens: 59, total_tokens: 2269, prompt_tokens_details: { cached_tokens: 1600 } })
  assert.equal(stats.rewrite_ms, 350)
  assert.equal(stats.rewrite_tokens, 219)
  assert.equal(stats.prefill_tokens, 400)
  assert.equal(stats.context_tokens, 2050)
  assert.equal(stats.ttft_ms, 200)
})

test('without a rewrite the rewrite fields are null', () => {
  const { stats } = summarize({ startedAt: 0, now: 10, rounds: [round({ promptTokens: 1, cacheTokens: 0, generatedTokens: 1 })] })
  assert.equal(stats.rewrite_ms, null)
  assert.equal(stats.rewrite_tokens, null)
})

test('a first turn with no cache to reuse reports none, and the context is what the round held', () => {
  // The real shape of turn 1 of a session on the direct engine: nothing to
  // reuse, yet cacheTokens is already larger than promptTokens because it is
  // the live KV after the system prompt, the question and the answer.
  const { usage, stats } = summarize({ startedAt: 0, now: 10, rounds: [round({ promptTokens: 2579, cacheTokens: 3494, generatedTokens: 326 })] })
  assert.equal(usage.prompt_tokens_details.cached_tokens, 589)
  assert.equal(usage.prompt_tokens, 3168)
  assert.equal(stats.context_tokens, 3494)
})

test('without a cache key the context is the prompt plus the answer', () => {
  const { stats } = summarize({ startedAt: 0, now: 10, rounds: [round({ promptTokens: 2732, cacheTokens: 0, generatedTokens: 336 })] })
  assert.equal(stats.context_tokens, 3068)
  assert.equal(stats.cache_ratio, 0)
})
