import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { catalog, key, missingFrom, targetsFor } from '../../src/runtime/models.js'

describe('targetsFor', () => {
  it('returns only what serve must load, in the selected tier', () => {
    const targets = targetsFor('M')
    assert.deepEqual(targets.map((target) => target.role).sort(), ['chat', 'embed'])
    assert.ok(targets.every((target) => target.tier === 'M' && target.resident))
    assert.equal(targets.find((target) => target.role === 'chat').constant, catalog.roles.chat.models.M.constant)
  })

  it('adds the on-demand roles when asked', () => {
    assert.ok(targetsFor('M', { optional: true }).length > targetsFor('M').length)
  })

  it('skips a role that has no model for the tier', () => {
    assert.ok(!targetsFor('S', { optional: true }).some((target) => target.role === 'vision'))
  })
})

describe('missingFrom', () => {
  const targets = targetsFor('M')

  it('lists every role when nothing has been fetched', () => {
    assert.deepEqual(missingFrom(null, targets).sort(), ['chat:M', 'embed:M'])
  })

  it('is empty once the manifest covers the targets', () => {
    const entries = Object.fromEntries(targets.map((target) => [key(target.role, target.tier), { path: '/tmp/x' }]))
    assert.deepEqual(missingFrom({ entries }, targets), [])
  })

  it('does not accept an entry from another tier', () => {
    assert.deepEqual(missingFrom({ entries: { 'chat:S': {}, 'embed:S': {} } }, targets).sort(), ['chat:M', 'embed:M'])
  })
})
