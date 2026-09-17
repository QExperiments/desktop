import * as sdk from '@qvac/sdk'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { publicKeyFromSeed } from '../p2p/identity.js'
import { createCancelRegistry } from './cancel.js'
import { selectTier } from './capability.js'
import { catalog, entryFor, provisionedTier, readManifest, targetsFor } from './models.js'
import { createPeerMonitor, DELEGATED_ROLES, peerSwapBlocked } from './peer.js'

const TIERS = ['L', 'M', 'S']
const FETCH_HINT = 'run `npm run models:fetch`'

export const createRuntime = ({ log = logger } = {}) => {
  const registry = createCancelRegistry({ cancel: sdk.cancel })
  const loaded = new Map()
  const idleTimers = new Map()
  let manifest = null
  let state = {
    ready: false,
    tier: null,
    hardware: null,
    reason: null,
    mode: 'local',
    isDelegated: false,
    providerPublicKey: null,
  }
  let peer = { publicKey: '', online: false, needsNewConnection: false, pending: null }
  let monitor = null
  let chain = Promise.resolve()
  let stopped = false

  const serial = (task) => {
    const next = chain.then(task, task)
    chain = next.then(() => {}, () => {})
    return next
  }

  const peerTier = () => (config.assumeStrongPeer ? 'L' : state.tier)

  const srcOf = (entry) => (entry.source === 'registry' ? sdk[entry.constant] : entry.path)

  const optionsFor = (entry, { delegated = false } = {}) => {
    const spec = catalog.roles[entry.role]
    const modelConfig = { ...spec.modelConfig }

    for (const [key, role] of Object.entries(spec.companions ?? {})) {
      if (delegated) {
        const companion = catalog.roles[role]?.models[entry.tier]
        if (companion?.constant && sdk[companion.constant]) modelConfig[key] = sdk[companion.constant]
      } else {
        const companion = entryFor(manifest, role, entry.tier)
        if (companion) modelConfig[key] = srcOf(companion)
      }
    }

    return {
      modelSrc: delegated ? sdk[entry.constant] : srcOf(entry),
      ...(entry.source === 'registry' || delegated ? {} : { modelType: entry.modelType }),
      ...(Object.keys(modelConfig).length ? { modelConfig } : {}),
    }
  }

  const load = (entry, extras = {}) =>
    registry.run({ kind: 'load', role: entry.role, tier: entry.tier }, () =>
      sdk.loadModel({ ...optionsFor(entry, { delegated: Boolean(extras.delegate) }), ...extras }))

  const loadDelegated = (role, spec) => {
    const modelSrc = sdk[spec.constant]
    if (!modelSrc) throw new Error(`${spec.constant} is not in the @qvac/sdk catalog`)

    return load(
      { ...spec, role, source: 'registry' },
      {
        modelSrc,
        delegate: {
          providerPublicKey: peer.publicKey,
          timeout: config.delegateTimeoutMs,
          fallbackToLocal: spec.tier === state.tier,
          ...(peer.needsNewConnection ? { forceNewConnection: true } : {}),
        },
      },
    )
  }

  const loadWithFallback = async (role) => {
    const candidates = TIERS.slice(TIERS.indexOf(state.tier))
      .map((tier) => entryFor(manifest, role, tier))
      .filter(Boolean)
    if (!candidates.length) throw new Error(`no ${role} model provisioned for tier ${state.tier} — ${FETCH_HINT}`)

    for (const [index, entry] of candidates.entries()) {
      try {
        const modelId = await load(entry)
        if (index > 0) log.warn({ role, tier: entry.tier }, 'fell back to a smaller model')

        return { modelId, entry }
      } catch (error) {
        if (index === candidates.length - 1) throw error
        log.warn({ role, tier: entry.tier, err: error.message }, 'model load failed, trying a smaller tier')
      }
    }
  }

  const remember = (role, modelId, entry, delegated) => {
    loaded.set(role, { modelId, entry, refs: 1, pins: 0, delegated })

    if (role === 'chat') {
      state = {
        ...state,
        isDelegated: delegated,
        mode: delegated ? 'delegated' : peer.publicKey ? 'local-fallback' : 'local',
        providerPublicKey: delegated ? peer.publicKey : null,
      }
    }

    log.info({ role, modelId, tier: entry.tier, source: entry.source, delegated }, 'model loaded')
    return modelId
  }

  const tryDelegated = async (role) => {
    const spec = catalog.roles[role]?.models[peerTier()]
    if (!peer.online || !DELEGATED_ROLES.has(role) || !spec?.constant) return null

    try {
      const modelId = await loadDelegated(role, { ...spec, tier: peerTier(), modelType: catalog.roles[role].modelType })
      const info = await sdk.getLoadedModelInfo({ modelId }).catch(() => null)
      const delegated = info?.isDelegated === true
      if (delegated) peer.needsNewConnection = false
      return remember(role, modelId, { ...spec, role, tier: peerTier(), source: 'registry' }, delegated)
    } catch (error) {
      log.warn({ role, err: error.message }, 'delegated load failed; loading local model')
      return null
    }
  }

  const acquireNow = async (role, { pin = true } = {}) => {
    clearTimeout(idleTimers.get(role))
    idleTimers.delete(role)
    const held = loaded.get(role)

    if (held) {
      held.refs += 1
      if (pin) held.pins += 1
      return held.modelId
    }

    if (!await tryDelegated(role)) {
      const local = await loadWithFallback(role)
      remember(role, local.modelId, local.entry, false)
    }

    const created = loaded.get(role)
    if (pin && created) created.pins += 1
    return created.modelId
  }

  const acquire = (role, options) => serial(() => acquireNow(role, options))

  const unloadNow = async (role) => {
    const held = loaded.get(role)
    if (!held) return
    clearTimeout(idleTimers.get(role))
    idleTimers.delete(role)
    await sdk.unloadModel({ modelId: held.modelId }).catch((error) => log.warn({ role, err: error.message }, 'unload failed'))
    loaded.delete(role)
    log.info({ role }, 'model unloaded')
  }

  const unload = (role) => serial(() => unloadNow(role))

  const failoverNow = async () => {
    const roles = [...loaded.entries()].filter(([, held]) => held.delegated).map(([role]) => role)
    if (!roles.length) {
      if (peer.publicKey && !state.isDelegated) {
        state = { ...state, mode: 'local-fallback', isDelegated: false, providerPublicKey: null }
      }
      return
    }

    log.warn({ roles }, 'provider dropped; failing over to local models')

    for (const role of roles) await unloadNow(role)

    for (const role of roles) {
      if (!catalog.roles[role]?.resident) continue
      const { modelId, entry } = await loadWithFallback(role)
      remember(role, modelId, entry, false)
    }
  }

  const reconnectNow = async () => {
    if (!peer.publicKey || !peer.online) return

    const roles = [...loaded.entries()]
      .filter(([role, held]) => DELEGATED_ROLES.has(role) && !held.delegated)
      .map(([role]) => role)

    if (!roles.length) return

    log.info({ roles }, 'provider back; reconnecting delegated models')

    for (const role of roles) {
      await unloadNow(role)
      const modelId = await tryDelegated(role)
      if (modelId) continue

      if (catalog.roles[role]?.resident) {
        const local = await loadWithFallback(role)
        remember(role, local.modelId, local.entry, false)
      }
    }
  }

  const settlePeer = () => serial(async () => {
    if (!peer.pending) return

    const targets = peer.pending === 'offline'
      ? [...loaded.entries()].filter(([, held]) => held.delegated).map(([role]) => role)
      : [...loaded.entries()].filter(([role, held]) => DELEGATED_ROLES.has(role) && !held.delegated).map(([role]) => role)

    if (peerSwapBlocked(loaded, targets)) return

    const action = peer.pending
    peer.pending = null
    if (action === 'offline') await failoverNow()
    else await reconnectNow()
  })

  const queuePeer = (action) => {
    peer.pending = action
    if (action === 'offline') {
      peer.online = false
      peer.needsNewConnection = true
    } else {
      peer.online = true
    }
    return settlePeer()
  }

  const release = (role) => {
    const held = loaded.get(role)
    if (!held) return
    if (held.pins > 0) held.pins -= 1
    if (!catalog.roles[role]?.resident) {
      held.refs -= 1
      if (held.refs <= 0) idleTimers.set(role, setTimeout(() => unload(role), config.idleUnloadMs).unref())
    }
    void settlePeer()
  }

  const hold = async (role, use) => {
    const tryUse = async () => {
      const modelId = await acquire(role)
      const delegated = loaded.get(role)?.delegated === true
      try {
        return await use(modelId)
      } catch (error) {
        if (delegated && error && typeof error === 'object') error.delegated = true
        throw error
      } finally {
        release(role)
      }
    }

    try {
      return await tryUse()
    } catch (error) {
      if (!error?.delegated || !peer.publicKey) throw error
      log.warn({ role, err: error.message }, 'delegated call failed; failing over to local')
      await queuePeer('offline')
      return tryUse()
    }
  }

  const start = async () => {
    const resources = await sdk.getSystemResources({ sample: true })
    const chosen = selectTier(resources, { ...catalog, override: config.tierOverride })
    if (!chosen.tier) throw new Error(`${chosen.reason}; set MERIDIAN_TIER=S to try anyway`)

    manifest = await readManifest(config.manifestPath)
    if (!manifest) throw new Error(`no ${config.manifestPath} — ${FETCH_HINT}`)

    const tier = await provisionedTier(manifest, chosen.tier, TIERS)
    if (!tier) throw new Error(`weights for tier ${chosen.tier} are missing or truncated — ${FETCH_HINT}`)

    peer = {
      publicKey: config.forceLocal ? '' : config.providerPublicKey,
      online: false,
      needsNewConnection: false,
      pending: null,
    }

    if (config.hyperswarmSeed) {
      try {
        log.info({ consumerPublicKey: publicKeyFromSeed(config.hyperswarmSeed) }, 'consumer identity for the provider firewall')
      } catch (error) {
        log.warn({ err: error.message }, 'could not derive consumer public key from QVAC_HYPERSWARM_SEED')
      }
    }

    if (peer.publicKey) {
      monitor = createPeerMonitor({
        heartbeat: sdk.heartbeat,
        providerPublicKey: peer.publicKey,
        retries: config.heartbeatRetries,
        timeoutMs: config.heartbeatTimeoutMs,
        retryDelayMs: config.heartbeatRetryDelayMs,
        intervalMs: config.heartbeatIntervalMs,
        log,
        onOnline: () => queuePeer('online'),
        onOffline: () => queuePeer('offline'),
      })
      peer.online = await monitor.start()
    }

    state = {
      ...state,
      tier,
      hardware: chosen.hardware,
      reason: chosen.reason,
      mode: peer.publicKey && !peer.online ? 'local-fallback' : 'local',
      isDelegated: false,
      providerPublicKey: null,
    }

    log.info(
      { tier, chosen: chosen.tier, reason: chosen.reason, hardware: chosen.hardware, peerOnline: peer.online },
      'runtime starting',
    )

    for (const target of targetsFor(tier)) await acquire(target.role, { pin: false })
    monitor?.watch()
    state.ready = true

    return snapshot()
  }

  const stop = async () => {
    if (stopped) return
    stopped = true
    state.ready = false
    monitor?.stop()
    peer.pending = null
    for (const timer of idleTimers.values()) clearTimeout(timer)
    idleTimers.clear()
    const cancelled = await registry.stopAll()

    for (const [role, held] of loaded) {
      await sdk.unloadModel({ modelId: held.modelId }).catch((error) => log.warn({ role, err: error.message }, 'unload failed'))
    }

    loaded.clear()
    await sdk.close()
    log.info({ cancelled }, 'runtime stopped')
  }

  const completion = async (params) => {
    const modelId = await acquire('chat')
    const run = sdk.completion({ modelId, ...params })
    registry.add(run.requestId, { kind: 'inference', role: 'chat' })

    return {
      run,
      requestId: run.requestId,
      settle: () => {
        registry.drop(run.requestId)
        release('chat')
      },
    }
  }

  const embed = (text) =>
    hold('embed', (modelId) => registry.run({ kind: 'embeddings', role: 'embed' }, () => sdk.embed({ modelId, text })))

  // Drops the KV-cache files the SDK keeps for one session key (req 6.3
  // cleanup). Nothing else on disk is touched; the session's turns stay.
  const deleteCache = (kvCacheKey) => sdk.deleteCache({ kvCacheKey }).catch((error) => {
    log.warn({ kvCacheKey, err: error.message }, 'kv-cache delete failed')
    return { success: false }
  })

  const transcribe = (audio, params = {}) =>
    hold('asr', (modelId) => registry.run({ kind: 'transcription', role: 'asr' }, () =>
      sdk.transcribe({ modelId, audioChunk: audio, ...params })))

  const transcribeStream = async (params = {}) => {
    const modelId = await acquire('asr')
    const session = await sdk.transcribeStream({ modelId, ...params })

    return { session, close: () => release('asr') }
  }

  const speak = (text, params = {}) =>
    hold('tts', (modelId) => registry.run({ kind: 'tts', role: 'tts' },
      () => sdk.textToSpeech({ modelId, text, inputType: 'text', stream: false, ...params }),
      (run) => run.buffer))

  const look = ({ prompt, imagePath, ...params }) =>
    hold('vision', async (modelId) => {
      const run = sdk.completion({
        modelId,
        history: [{ role: 'user', content: prompt, attachments: [{ path: imagePath }] }],
        ...params,
      })

      registry.add(run.requestId, { kind: 'inference', role: 'vision' })

      try {
        return (await run.final).contentText
      } finally {
        registry.drop(run.requestId)
      }
    })

  const snapshot = () => ({
    ...state,
    peerOnline: peer.online,
    models: [...loaded].map(([role, held]) => ({
      role,
      modelId: held.modelId,
      tier: held.entry.tier,
      source: held.entry.source,
      constant: held.entry.constant,
      delegated: held.delegated === true,
    })),
    onDemand: Object.keys(catalog.roles).filter((role) => !catalog.roles[role].required && entryFor(manifest, role, state.tier)),
    inflight: registry.list().map(({ abort, ...rest }) => rest),
  })

  return { start, stop, acquire, release, completion, embed, deleteCache, transcribe, transcribeStream, speak, look, snapshot, cancel: registry.stop }
}
