import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCatalog, readRegistry, registrySnapshot } from '../../src/runtime/catalog.js'

let dir
before(async () => { dir = await mkdtemp(join(tmpdir(), 'catalog-')) })
after(() => rm(dir, { recursive: true, force: true }))

const catalog = {
  tiers: { S: { minBudgetBytes: 10, label: 'small' }, M: { minBudgetBytes: 20, label: 'fleet' } },
  osReserveBytes: 5,
  roles: {
    chat: { addon: 'llm', required: true, resident: true, models: { S: { constant: 'CHAT_S', file: 'chat-s.gguf', bytes: 5, sha256: 'aaa', modelConfig: { ctx_size: 8192 } }, M: { constant: 'CHAT_M', file: 'chat-m.gguf', bytes: 8, sha256: 'bbb' } } },
    asr: { addon: 'whisper', required: false, resident: false, models: { S: { constant: 'ASR_S', file: 'asr.bin', bytes: 3, sha256: 'ccc' } } },
  },
}

test('the catalog marks provisioned weights, registry matches and the tiers the budget affords', async () => {
  const chatPath = join(dir, 'chat-s.gguf')
  await writeFile(chatPath, 'hello')
  const truncated = join(dir, 'asr.bin')
  await writeFile(truncated, 'x')
  const manifest = { entries: {
    'chat:S': { role: 'chat', tier: 'S', constant: 'CHAT_S', source: 'https', path: chatPath, bytes: 5, fetchedAt: 't0' },
    'asr:S': { role: 'asr', tier: 'S', constant: 'ASR_S', source: 'registry', path: truncated, bytes: 3 },
  } }
  const registry = registrySnapshot([
    { name: 'chat s', modelId: 'chat-s', addon: 'llm', engine: 'llamacpp-completion', expectedSize: 5, sha256Checksum: 'aaa', quantization: 'Q8_0', params: '0.8B', registrySource: 'hf', blobCoreKey: 'secret' },
    { name: 'chat m', modelId: 'chat-m', addon: 'llm', engine: 'llamacpp-completion', expectedSize: 9, sha256Checksum: 'bbb', quantization: 'Q4_K_M', params: '2B', registrySource: 'hf' },
  ], new Date('2026-09-18T00:00:00Z'))
  assert.equal('blobCoreKey' in registry.models[0], false)

  const view = await buildCatalog({ catalog, manifest, registry, tier: 'S', budgetBytes: 12 })
  assert.equal(view.tier, 'S')
  assert.deepEqual(view.tiers.map((t) => [t.tier, t.withinBudget, t.serving, t.residentBytes]), [['S', true, true, 5], ['M', false, false, 8]])
  assert.equal(view.registry.count, 2)

  const chat = view.roles.find((r) => r.role === 'chat')
  assert.equal(chat.resident, true)
  const [s, m] = chat.models
  assert.equal(s.provisioned, true)
  assert.equal(s.source, 'https')
  assert.equal(s.ctx, 8192)
  assert.deepEqual(s.registry, { found: true, sizeMatches: true, quantization: 'Q8_0', params: '0.8B' })
  assert.equal(m.provisioned, false)
  assert.equal(m.path, null)
  assert.equal(m.registry.sizeMatches, false)
  assert.equal(m.withinBudget, false)

  // A truncated file is not provisioned even though the manifest lists it.
  const asr = view.roles.find((r) => r.role === 'asr').models[0]
  assert.equal(asr.provisioned, false)
  assert.deepEqual(asr.registry, { found: false })
})

test('without a registry snapshot or a budget the unknowns are null, not false', async () => {
  const view = await buildCatalog({ catalog, manifest: null, registry: null, tier: 'M', budgetBytes: null })
  assert.equal(view.registry, null)
  assert.equal(view.budgetBytes, null)
  assert.ok(view.roles.flatMap((r) => r.models).every((m) => m.registry === null && m.withinBudget === null && m.provisioned === false))
  assert.equal(await readRegistry(join(dir, 'missing.json')), null)
})
