// Opt in with `npm run test:e2e` after `npm run models:fetch`. Loads real
// weights, so it is kept out of the unit suite and out of CI.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

const enabled = process.env.MERIDIAN_E2E === '1'
const quiet = { info: () => {}, warn: () => {}, error: () => {} }

describe('runtime lifecycle', { skip: enabled ? false : 'set MERIDIAN_E2E=1 to run' }, () => {
  let runtime
  let state

  before(async () => {
    const { createRuntime } = await import('../../src/runtime/index.js')
    runtime = createRuntime({ log: quiet })
    state = await runtime.start()
  })

  after(async () => { await runtime?.stop() })

  it('loads the resident models and reports the tier it serves', () => {
    assert.equal(state.ready, true)
    assert.ok(['S', 'M', 'L'].includes(state.tier))
    assert.deepEqual(state.models.map((model) => model.role).sort(), ['chat', 'embed'])
  })

  it('embeds text at the dimension the store will have to match', async () => {
    const { embedding } = await runtime.embed('ServoDrive X4 lead time')
    assert.ok(embedding.length > 0)
    assert.ok(embedding.every((value) => Number.isFinite(value)))
  })

  it('streams a completion to the end', async () => {
    const { run, settle } = await runtime.completion({
      history: [{ role: 'user', content: 'Reply with the single word: ready' }],
      generationParams: { temp: 0, seed: 7, predict: 16 },
    })
    let text = ''
    for await (const event of run.events) if (event.type === 'contentDelta') text += event.text
    settle()
    assert.ok(text.trim().length > 0)
    assert.equal(runtime.snapshot().inflight.length, 0)
  })

  it('cancels an inference by requestId and stays usable afterwards', async () => {
    const { run, requestId, settle } = await runtime.completion({
      history: [{ role: 'user', content: 'Count slowly from one to five hundred.' }],
      generationParams: { temp: 0, seed: 7, predict: 512 },
    })
    assert.ok(runtime.snapshot().inflight.some((entry) => entry.requestId === requestId))

    let seen = 0
    for await (const event of run.events) {
      if (event.type !== 'contentDelta') continue
      if (++seen === 3) await runtime.cancel(requestId)
    }
    settle()

    assert.ok(seen >= 3)
    assert.equal(runtime.snapshot().inflight.length, 0)
    const after = await runtime.completion({ history: [{ role: 'user', content: 'Say ok' }], generationParams: { temp: 0, seed: 7, predict: 8 } })
    await after.run.final
    after.settle()
  })
})
