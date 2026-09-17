import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { selectTier } from '../../src/runtime/capability.js'
import catalog from '../../models.json' with { type: 'json' }

const GiB = 1024 ** 3
const ok = (value) => ({ status: 'supported', value })
const gone = { status: 'unavailable', reason: 'Metric is unavailable' }

const device = ({ gib, drivers = {}, unifiedMemory = true, memory = ok(gib * GiB) }) => ({
  capabilities: {
    cpu: ok({ name: ok('test cpu') }),
    memory: { totalBytes: memory },
    gpus: ok([{ name: ok('test gpu'), unifiedMemory: ok(unifiedMemory), drivers: Object.fromEntries(Object.entries(drivers).map(([k, v]) => [k, ok(v)])) }]),
  },
})

describe('selectTier', () => {
  it('puts the 2019 fleet laptop on the middle tier', () => {
    const { tier, hardware } = selectTier(device({ gib: 8, drivers: { vulkan: true, metal: false } }), catalog)
    assert.equal(tier, 'M')
    assert.equal(hardware.backend, 'vulkan')
    assert.equal(hardware.dedicatedGpu, false)
  })

  it('puts a workstation on the large tier', () => {
    assert.equal(selectTier(device({ gib: 32, drivers: { cuda: true }, unifiedMemory: false }), catalog).tier, 'L')
  })

  it('drops a 6 GB machine to the small tier', () => {
    assert.equal(selectTier(device({ gib: 6 }), catalog).tier, 'S')
  })

  it('refuses a 4 GB machine with the RAM it would need', () => {
    const { tier, reason } = selectTier(device({ gib: 4 }), catalog)
    assert.equal(tier, null)
    assert.match(reason, /4\.0 GiB RAM is below the 5\.0 GiB/)
  })

  it('falls back to CPU when no GPU driver is usable', () => {
    assert.equal(selectTier(device({ gib: 8, drivers: { vulkan: false } }), catalog).hardware.backend, 'cpu')
  })

  it('assumes the smallest tier when RAM cannot be read', () => {
    const { tier, budgetBytes } = selectTier(device({ gib: 8, memory: gone }), catalog)
    assert.equal(tier, 'S')
    assert.equal(budgetBytes, null)
  })

  it('honors MERIDIAN_TIER and rejects an unknown value', () => {
    assert.equal(selectTier(device({ gib: 32 }), { ...catalog, override: 'S' }).tier, 'S')
    assert.throws(() => selectTier(device({ gib: 8 }), { ...catalog, override: 'XL' }), /MERIDIAN_TIER/)
  })
})

describe('models.json', () => {
  it('covers every tier for the roles this stage loads', () => {
    for (const [name, role] of Object.entries(catalog.roles)) {
      if (!role.required) continue
      for (const tier of Object.keys(catalog.tiers)) {
        const model = role.models[tier]
        assert.ok(model, `${name} is missing tier ${tier}`)
        assert.match(model.sha256, /^[0-9a-f]{64}$/, `${name}/${tier} has no usable checksum`)
        assert.ok(model.bytes > 0)
      }
    }
  })

  it('gives every chat tier a context size and shares chat weights with vision on S and L', () => {
    for (const tier of ['S', 'M', 'L']) assert.ok(catalog.roles.chat.models[tier].modelConfig.ctx_size >= 8192, `chat/${tier} has no ctx_size`)
    for (const tier of ['S', 'L']) assert.equal(catalog.roles.chat.models[tier].file, catalog.roles.vision.models[tier].file)
  })

  it('keeps the middle tier inside the 8 GB budget', () => {
    const resident = Object.values(catalog.roles).filter((role) => role.resident)
    const bytes = resident.reduce((sum, role) => sum + role.models.M.bytes, 0)
    assert.ok(bytes < catalog.tiers.M.minBudgetBytes, `${bytes} bytes of resident weights exceeds the M budget`)
  })
})
