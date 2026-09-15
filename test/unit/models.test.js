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

  it('never returns a role the tier has no model for', () => {
    for (const tier of Object.keys(catalog.tiers)) {
      for (const target of targetsFor(tier, { optional: true })) {
        assert.ok(catalog.roles[target.role].models[tier], `${target.role} has no ${tier} model`)
      }
    }
  })

  it('pairs every vision model with a projection for the same tier', () => {
    const { projectionRole, models } = catalog.roles.vision
    assert.equal(projectionRole, 'visionProjection')
    for (const tier of Object.keys(models)) assert.ok(catalog.roles[projectionRole].models[tier], `no projection for ${tier}`)
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
