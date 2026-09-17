import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPeerMonitor, DELEGATED_ROLES, peerSwapBlocked, waitForPeer } from '../../src/runtime/peer.js'

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

describe('peerSwapBlocked', () => {
  it('blocks a swap only while a targeted role is pinned', () => {
    const loaded = new Map([
      ['chat', { pins: 1, delegated: true }],
      ['asr', { pins: 0, delegated: true }],
    ])
    assert.equal(peerSwapBlocked(loaded, ['chat']), true)
    assert.equal(peerSwapBlocked(loaded, ['asr']), false)
    loaded.get('chat').pins = 0
    assert.equal(peerSwapBlocked(loaded, ['chat']), false)
  })
})

describe('createPeerMonitor', () => {
  const startMonitor = async (heartbeat) => {
    const events = []
    const ticks = []
    const monitor = createPeerMonitor({
      heartbeat,
      providerPublicKey: 'peer-key',
      retries: 2,
      timeoutMs: 10,
      retryDelayMs: 0,
      intervalMs: 1000,
      log: quiet,
      onOnline: async () => events.push('up'),
      onOffline: async () => events.push('down'),
      setIntervalFn: (fn) => {
        ticks.push(fn)
        return 1
      },
      clearIntervalFn: () => {},
    })
    const online = await monitor.start()
    monitor.watch()
    return { monitor, events, ticks, online }
  }

  it('probes at startup and later reports drop then recovery', async () => {
    let alive = true
    const { monitor, events, ticks, online } = await startMonitor(async () => {
      if (!alive) throw new Error('down')
    })
    assert.equal(online, true)
    assert.equal(ticks.length, 1)
    assert.deepEqual(events, [])

    alive = false
    await monitor.tick()
    assert.deepEqual(events, ['down'])
    assert.equal(monitor.online, false)

    alive = true
    await monitor.tick()
    assert.deepEqual(events, ['down', 'up'])
    assert.equal(monitor.online, true)
    monitor.stop()
  })

  it('does not call onOnline for a peer that was already down at start', async () => {
    const { events, online, monitor } = await startMonitor(async () => {
      throw new Error('down')
    })
    assert.equal(online, false)
    assert.deepEqual(events, [])
    monitor.stop()
  })

  it('reports recovery for a peer that was down at start', async () => {
    let alive = false
    const { monitor, events } = await startMonitor(async () => {
      if (!alive) throw new Error('down')
    })

    alive = true
    await monitor.tick()

    assert.deepEqual(events, ['up'])
    assert.equal(monitor.online, true)

    monitor.stop()
  })
})
