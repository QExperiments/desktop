import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createCancelRegistry } from '../../src/runtime/cancel.js'

const decorated = (requestId, promise) => Object.assign(promise, { requestId })

describe('cancel registry', () => {
  it('tracks a call while it runs and forgets it after', async () => {
    const registry = createCancelRegistry({ cancel: async () => {} })
    let inside = 0
    await registry.run({ kind: 'load' }, () =>
      decorated('req-1', Promise.resolve().then(() => { inside = registry.list().length })))
    assert.equal(inside, 1)
    assert.equal(registry.list().length, 0)
  })

  it('forgets a call that throws', async () => {
    const registry = createCancelRegistry({ cancel: async () => {} })
    await assert.rejects(registry.run({ kind: 'load' }, () => decorated('req-1', Promise.reject(new Error('boom')))))
    assert.equal(registry.list().length, 0)
  })

  it('cancels one request by id and passes clearCache through', async () => {
    const calls = []
    const registry = createCancelRegistry({ cancel: async (params) => calls.push(params) })
    registry.add('req-1', { kind: 'download', role: 'chat' })
    const entry = await registry.stop('req-1', { clearCache: true })
    assert.equal(entry.role, 'chat')
    assert.deepEqual(calls, [{ requestId: 'req-1', clearCache: true }])
  })

  it('returns null for an unknown request instead of calling the SDK', async () => {
    const registry = createCancelRegistry({ cancel: async () => assert.fail('should not be called') })
    assert.equal(await registry.stop('nope'), null)
  })

  it('uses the local abort hook when one is registered', async () => {
    let aborted = false
    const registry = createCancelRegistry({ cancel: async () => assert.fail('should not be called') })
    registry.add('req-1', { kind: 'download', abort: () => { aborted = true } })
    await registry.stop('req-1')
    assert.ok(aborted)
  })

  it('cancels everything in flight on shutdown', async () => {
    const stopped = []
    const registry = createCancelRegistry({ cancel: async ({ requestId }) => stopped.push(requestId) })
    registry.add('a', { kind: 'load' })
    registry.add('b', { kind: 'inference' })
    assert.equal(await registry.stopAll(), 2)
    assert.deepEqual(stopped.sort(), ['a', 'b'])
  })
})
