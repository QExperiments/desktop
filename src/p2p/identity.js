import { createPrivateKey, createPublicKey } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// PKCS#8 wrapper around a 32-byte Ed25519 seed. Same construction Hyperswarm
// uses for QVAC_HYPERSWARM_SEED, so the hex we print is the firewall key.
// Live checklist: docs/p2p-test.md
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export const normalizeSeed = (hex) => {
  const seed = String(hex ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(seed)) {
    throw new Error('QVAC_HYPERSWARM_SEED must be 64 hex characters')
  }
  return seed
}

export const publicKeyFromSeed = (hex) => {
  const seed = Buffer.from(normalizeSeed(hex), 'hex')
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })

  return Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('hex')
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isCli) {
  try {
    const seed = process.argv[2] || process.env.QVAC_HYPERSWARM_SEED

    if (!seed) {
      console.error('usage: npm run identity -- <64-hex-seed>')
      process.exit(1)
    }
    console.log(publicKeyFromSeed(seed))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
