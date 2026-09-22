// Opt in with `npm run test:e2e` after `npm run models:fetch`. Chat and
// embeddings give their memory back after MERIDIAN_RESIDENT_IDLE_MS without a
// request and load again on the next one; here the hour is cut to a fraction
// of a second so the round trip fits a test.
process.env.MERIDIAN_RESIDENT_IDLE_MS ??= '3000'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const enabled = process.env.MERIDIAN_E2E === '1'
const quiet = { info: () => {}, warn: () => {}, error: () => {} }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('resident models unload when idle', { skip: enabled ? false : 'set MERIDIAN_E2E=1 to run' }, () => {
  let runtime

  before(async () => {
    const { createRuntime } = await import('../../src/runtime/index.js')
    runtime = createRuntime({ log: quiet })
    await runtime.start()
  })

  after(async () => { await runtime?.stop() })

  it('gives chat and embeddings back after the idle period and reports them as unloaded', async () => {
    assert.deepEqual(runtime.snapshot().models.map((m) => m.role).sort(), ['chat', 'embed'])
    await wait(Number(process.env.MERIDIAN_RESIDENT_IDLE_MS) + 1500)
    const idle = runtime.snapshot()
    assert.equal(idle.ready, true, 'the server stays ready; the next request reloads')
    assert.deepEqual(idle.models, [])
    assert.deepEqual(idle.unloaded.sort(), ['chat', 'embed'])
  })

  it('loads them again on the next request and rearms the timer', async () => {
    const { embedding } = await runtime.embed('ServoDrive X4 lead time')
    assert.ok(embedding.length > 0)
    const { run, settle } = await runtime.completion({ history: [{ role: 'user', content: 'Reply with the single word: ready' }], generationParams: { temp: 0, seed: 7, predict: 8 } })
    await run.final
    settle()
    assert.deepEqual(runtime.snapshot().models.map((m) => m.role).sort(), ['chat', 'embed'])
    assert.deepEqual(runtime.snapshot().unloaded, [])
    await wait(Number(process.env.MERIDIAN_RESIDENT_IDLE_MS) + 1500)
    assert.deepEqual(runtime.snapshot().unloaded.sort(), ['chat', 'embed'])
  })
})
