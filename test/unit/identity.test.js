import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeSeed, publicKeyFromSeed } from '../../src/p2p/identity.js'

const SEED = '11'.repeat(32)

describe('publicKeyFromSeed', () => {
  it('derives a stable 32-byte hex key from a 64-char seed', () => {
    const key = publicKeyFromSeed(SEED)
    assert.match(key, /^[0-9a-f]{64}$/)
    assert.equal(key, publicKeyFromSeed(`  ${SEED.toUpperCase()}  `))
    assert.equal(key, 'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737')
  })

  it('rejects a seed that is not 64 hex characters', () => {
    assert.throws(() => normalizeSeed('abc'), /64 hex/)
    assert.throws(() => publicKeyFromSeed('zz'.repeat(32)), /64 hex/)
  })
})
