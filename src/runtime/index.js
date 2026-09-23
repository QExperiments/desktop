import * as sdk from '@qvac/sdk'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { publicKeyFromSeed } from '../p2p/identity.js'
import { createCancelRegistry } from './cancel.js'
import { selectTier } from './capability.js'
import { buildCatalog, readRegistry } from './catalog.js'
import { catalog, entryFor, provisionedTier, readManifest, targetsFor } from './models.js'
import { createDirectChat } from './direct/client.js'
import { createPeerMonitor, DELEGATED_ROLES, peerSwapBlocked } from './peer.js'
import { createProfile } from './profile.js'

const TIERS = ['L', 'M', 'S']
const FETCH_HINT = 'run `npm run models:fetch`'

// A weight this machine was never given is the operator's to fix, not a crash:
// the HTTP layer answers it with 503 and the hint.
const notProvisioned = (role, tier) =>
  Object.assign(new Error(`no ${role} model provisioned for tier ${tier} — ${FETCH_HINT}`), { statusCode: 503 })

export const createRuntime = ({ log = logger } = {}) => {
  // Enabled before anything else so the profiler sees the model loads: the
  // SDK records an operation only while it is on (I.6).
  const profile = createProfile({ log })
  const registry = createCancelRegistry({ cancel: sdk.cancel })
  const loaded = new Map()
  const idleTimers = new Map()
  let manifest = null
  let state = {
    ready: false,
    tier: null,
    budgetBytes: null,
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
  // Called with the role after an idle unload; the server drops the sessions'
  // KV files when chat goes (see unloadIdle for why).
  const idleListeners = new Set()

  const serial = (task) => {
    const next = chain.then(task, task)
    chain = next.then(() => {}, () => {})
    return next
  }

  const peerTier = () => (config.assumeStrongPeer ? 'L' : state.tier)

  // The direct engine keeps the chat model in its own Bare child, so it needs
  // the weights on disk and the same model config the SDK would have applied.
  // While it is on, the SDK never loads chat: two copies do not fit the fleet
  // laptop.
  const DIRECT = config.retrieval.engine === 'direct'
  let direct = null
  const directChat = async () => {
    if (direct) return direct
    const entry = entryFor(manifest, 'chat', state.tier)
    if (!entry) throw notProvisioned('chat', state.tier)
    const spec = catalog.roles.chat
    const onGpu = (state.hardware?.backend ?? 'cpu') !== 'cpu'
    direct = createDirectChat({ log })
    await direct.load({
      model: entry.path,
      config: withChatOverrides('chat', {
        device: onGpu ? 'gpu' : 'cpu',
        ...(onGpu ? { gpu_layers: 99 } : {}),
        ...spec.modelConfig,
        ...spec.models[entry.tier]?.modelConfig,
      }),
      cacheDir: config.directCacheDir,
    })
    log.info({ tier: entry.tier, model: entry.constant, device: onGpu ? 'gpu' : 'cpu' }, 'direct chat engine loaded')
    return direct
  }
  const isResident = (role) => catalog.roles[role]?.resident === true

  const srcOf = (entry) => (entry.source === 'registry' ? sdk[entry.constant] : entry.path)

  // The chat role's context and its sliding window are the two settings an
  // experiment moves without touching models.json (src/config.js).
  const withChatOverrides = (role, modelConfig) => {
    if (role !== 'chat') return modelConfig
    if (config.chatCtx) modelConfig.ctx_size = config.chatCtx
    if (config.chatDiscard) modelConfig.n_discarded = config.chatDiscard
    return modelConfig
  }

  const optionsFor = (entry, { delegated = false } = {}) => {
    const spec = catalog.roles[entry.role]
    // Role-wide settings first, then what the tier's own model entry adds (ctx_size).
    const modelConfig = withChatOverrides(entry.role, { ...spec.modelConfig, ...spec.models[entry.tier]?.modelConfig })

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
      // An entry fetched before models.json moved on (Supertonic 2 once) is not
      // the model the catalog describes; models:fetch replaces it.
      .filter((entry) => entry && entry.constant === catalog.roles[role]?.models[entry.tier]?.constant)
    if (!candidates.length) throw notProvisioned(role, state.tier)

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

  const unloadNow = async (role, { idle = false } = {}) => {
    const held = loaded.get(role)
    if (!held) return
    clearTimeout(idleTimers.get(role))
    idleTimers.delete(role)
    await sdk.unloadModel({ modelId: held.modelId }).catch((error) => log.warn({ role, err: error.message }, 'unload failed'))
    loaded.delete(role)
    log.info({ role, idle }, 'model unloaded')
  }

  // Idle unload. On-demand roles (speech, vision) go idleUnloadMs after their
  // last user let go; resident roles (chat, embed) go residentIdleMs after
  // their last request, and the next request loads them again (ADR-006). The
  // unload runs on the serial chain, so a request that arrived after the timer
  // fired and re-acquired the model is seen here and the unload is skipped.
  const idleFor = (role) => (isResident(role) ? config.residentIdleMs : config.idleUnloadMs)
  const inUse = (role, held) => (isResident(role) ? held.pins > 0 : held.refs > 0)

  // Measured 2026-09-18 (tier M, dev Mac): after an unload and reload the SDK
  // loads a session's KV file from disk and then prefills the whole history
  // again on top of it, so the next turn cost 2385 prompt tokens instead of
  // 626 and the context grew to 6.9k instead of 3.2k. The listeners delete
  // the sessions' KV files instead, and the next turn primes a fresh file from
  // the stored history: one clean prefill, the same as reopening an old session.
  const unloadIdle = (role) => serial(async () => {
    const held = loaded.get(role)
    if (!held || inUse(role, held)) return
    await unloadNow(role, { idle: true })
    for (const listener of idleListeners) await Promise.resolve().then(() => listener(role)).catch((error) => log.warn({ role, err: error.message }, 'idle listener failed'))
  })
  const onIdleUnload = (listener) => { idleListeners.add(listener) }

  const armIdle = (role) => {
    const held = loaded.get(role)
    const ms = idleFor(role)
    if (!held || !(ms > 0) || inUse(role, held)) return
    clearTimeout(idleTimers.get(role))
    idleTimers.set(role, setTimeout(() => unloadIdle(role), ms).unref())
  }

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
      armIdle(role)
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
      armIdle(role)
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
    if (!isResident(role)) held.refs -= 1
    armIdle(role)
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
      budgetBytes: chosen.budgetBytes ?? null,
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

    for (const target of targetsFor(tier)) {
      if (DIRECT && target.role === 'chat') continue
      await acquire(target.role, { pin: false })
    }
    if (DIRECT) await directChat()
    // The idle clock of the resident roles starts at boot, not at the first request.
    for (const target of targetsFor(tier)) if (!(DIRECT && target.role === 'chat')) armIdle(target.role)
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
    await direct?.close().catch((error) => log.warn({ err: error.message }, 'direct chat close failed'))
    direct = null
    // Before close(): the export reads state the SDK owns.
    await profile.dump().catch((error) => log.warn({ err: error.message }, 'profile dump failed'))
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

  // GET /v1/models/catalog: read-only, from models.json, the manifest and the
  // registry snapshot `models:list --refresh` left on disk. Never downloads.
  const modelCatalog = async () => buildCatalog({
    catalog, manifest, registry: await readRegistry(config.registryPath), tier: state.tier, budgetBytes: state.budgetBytes,
  })

  const snapshot = () => ({
    ...state,
    peerOnline: peer.online,
    residentIdleMs: config.residentIdleMs,
    // Resident roles that gave their memory back after residentIdleMs without a
    // request; the next request loads them again. Empty while everything is up.
    unloaded: state.ready ? Object.keys(catalog.roles).filter((role) => isResident(role) && catalog.roles[role].models[state.tier] && !loaded.has(role) && !(DIRECT && role === 'chat' && direct)) : [],
    models: [
      // The direct engine holds chat outside the SDK's registry, so /health
      // would otherwise report a server running without a chat model.
      ...(DIRECT && direct && state.ready
        ? [{ role: 'chat', modelId: 'direct', tier: entryFor(manifest, 'chat', state.tier)?.tier ?? state.tier, source: entryFor(manifest, 'chat', state.tier)?.source ?? null, constant: entryFor(manifest, 'chat', state.tier)?.constant ?? null, delegated: false, engine: 'direct' }]
        : []),
      ...[...loaded].map(([role, held]) => ({
        role,
        modelId: held.modelId,
        tier: held.entry.tier,
        source: held.entry.source,
        constant: held.entry.constant,
        delegated: held.delegated === true,
      })),
    ],
    onDemand: Object.keys(catalog.roles).filter((role) => !catalog.roles[role].required && entryFor(manifest, role, state.tier)),
    inflight: registry.list().map(({ abort, ...rest }) => rest),
  })

  return { start, stop, acquire, release, completion, directChat, embed, deleteCache, transcribe, transcribeStream, speak, look, snapshot, modelCatalog, onIdleUnload, cancel: registry.stop, profile }
}
