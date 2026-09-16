import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { key, provisionedTier, targetsFor } from '../../src/runtime/models.js'

let dir

const manifestFor = async (tier, { truncate = [], drop = [] } = {}) => {
  const entries = {}
  for (const target of targetsFor(tier)) {
    if (drop.includes(target.role)) continue
    const path = join(dir, `${target.role}-${tier}.gguf`)
    const bytes = truncate.includes(target.role) ? 8 : 16
    await writeFile(path, Buffer.alloc(bytes))
    entries[key(target.role, tier)] = { role: target.role, tier, path, bytes: 16 }
  }
  return { entries }
}

before(async () => { dir = await mkdtemp(join(tmpdir(), 'meridian-')) })
after(async () => { await rm(dir, { recursive: true, force: true }) })

describe('provisionedTier', () => {
  it('serves the tier the machine was measured at when it is complete', async () => {
    assert.equal(await provisionedTier(await manifestFor('M'), 'M'), 'M')
  })

  it('serves a smaller complete tier when the preferred one was never fetched', async () => {
    assert.equal(await provisionedTier(await manifestFor('S'), 'L'), 'S')
  })

  it('refuses a tier whose weights are truncated', async () => {
    assert.equal(await provisionedTier(await manifestFor('M', { truncate: ['chat'] }), 'M'), null)
  })

  it('refuses a tier that is missing a role', async () => {
    assert.equal(await provisionedTier(await manifestFor('M', { drop: ['embed'] }), 'M'), null)
  })

  it('refuses an empty manifest, which is what makes serve fail loudly offline', async () => {
    assert.equal(await provisionedTier({ entries: {} }, 'M'), null)
    assert.equal(await provisionedTier(null, 'M'), null)
  })
})
