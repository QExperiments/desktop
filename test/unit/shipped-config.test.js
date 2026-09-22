import assert from 'node:assert/strict'
import { test } from 'node:test'
import { config } from '../../src/config.js'

// The configuration the 2026-09-21 run measured, as evals/config.json states
// it for the `config-auto` variant. Until 2026-09-22 the server shipped
// budget 0, keepMessages 0 and dropToolRounds false, so `npm run serve`
// answered every turn with a full prefill while the report showed a cache
// ratio of 0.46. A default that drifts from the measured variant makes the
// numbers in the report describe a system nobody runs.
const MEASURED = { layout: 'current', budget: 26214, keepMessages: 10, dropToolRounds: true, topK: 5, mode: 'auto' }

test('the shipped defaults are the configuration the eval measured', () => {
  for (const [key, value] of Object.entries(MEASURED)) assert.equal(config.retrieval[key], value, key)
})

test('the defaults let a session keep its KV cache', () => {
  // answer.js: cacheable = !DIRECT && KEEP_TURNS <= 0 && session && (LAYOUT !== 'current' || CTX_BUDGET > 0)
  const { engine, keepTurns, layout, budget } = config.retrieval
  assert.equal(engine !== 'direct' && keepTurns <= 0 && (layout !== 'current' || budget > 0), true)
})
