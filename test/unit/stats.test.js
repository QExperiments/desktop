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
      round({ promptTokens: 900, cacheTokens: 700, generatedTokens: 40, timeToFirstToken: 400, tokensPerSecond: 80, backendDevice: 'gpu' }, [{ name: 'lookup_stock', args: { sku: 'SD-X4-001' }, ms: 5 }]),
      round({ promptTokens: 1000, cacheTokens: 940, generatedTokens: 60, timeToFirstToken: 150, tokensPerSecond: 60 }),
    ],
  })
  // processed 900 + 1000 plus cached 700 + 940 are all prompt tokens to OpenAI
  assert.deepEqual(usage, { prompt_tokens: 3540, completion_tokens: 100, total_tokens: 3640, prompt_tokens_details: { cached_tokens: 1640 } })
  assert.equal(stats.prefill_tokens, 1900)
  assert.equal(stats.ttft_ms, 400)
  assert.equal(stats.rounds, 2)
  assert.equal(stats.total_ms, 3000)
  assert.equal(stats.retrieval_ms, 120)
  assert.equal(stats.tool_ms, 5)
  assert.equal(stats.cache_ratio, 0.463)
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
