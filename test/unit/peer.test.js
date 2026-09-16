import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DELEGATED_ROLES, waitForPeer } from '../../src/runtime/peer.js'

const quiet = { info: () => {}, warn: () => {}, error: () => {} }

describe('DELEGATED_ROLES', () => {
  it('covers chat, transcription and speech, not embeddings or vision', () => {
    assert.deepEqual([...DELEGATED_ROLES].sort(), ['asr', 'chat', 'tts'])
  })
})

describe('waitForPeer', () => {
  it('skips the network when no public key is set', async () => {
    let calls = 0
    const online = await waitForPeer({
      heartbeat: async () => {
        calls += 1
      },
      providerPublicKey: '',
      retries: 3,
      timeoutMs: 10,
      retryDelayMs: 0,
      log: quiet,
    })
    assert.equal(online, false)
    assert.equal(calls, 0)
  })

  it('returns true on the first successful heartbeat', async () => {
    const online = await waitForPeer({
      heartbeat: async () => {},
      providerPublicKey: 'peer-key',
      retries: 3,
      timeoutMs: 10,
      retryDelayMs: 0,
      log: quiet,
    })
    assert.equal(online, true)
  })

  it('retries and then falls back to local when the peer never answers', async () => {
    let calls = 0
    const online = await waitForPeer({
      heartbeat: async () => {
        calls += 1
        throw new Error('timeout')
      },
      providerPublicKey: 'peer-key',
      retries: 3,
      timeoutMs: 10,
      retryDelayMs: 0,
      log: quiet,
    })
    assert.equal(online, false)
    assert.equal(calls, 3)
  })
})
