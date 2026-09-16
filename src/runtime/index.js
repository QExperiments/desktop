import * as sdk from '@qvac/sdk'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { createCancelRegistry } from './cancel.js'
import { selectTier } from './capability.js'
import { catalog, entryFor, provisionedTier, readManifest, targetsFor } from './models.js'
import { DELEGATED_ROLES, waitForPeer } from './peer.js'

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
  let peer = { publicKey: '', online: false }
  let chain = Promise.resolve()
  let stopped = false

  const serial = (task) => {
    const next = chain.then(task, task)
    chain = next.then(() => {}, () => {})
    return next
  }

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
    loaded.set(role, { modelId, entry, refs: 1, delegated })

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

  const acquire = (role) => serial(async () => {
    clearTimeout(idleTimers.get(role))

    idleTimers.delete(role)
    const held = loaded.get(role)

    if (held) {
      held.refs += 1
      return held.modelId
    }

    const peerTier = config.assumeStrongPeer ? 'L' : state.tier
    const spec = catalog.roles[role]?.models[peerTier]

    if (peer.online && DELEGATED_ROLES.has(role) && spec?.constant) {
      try {
        const modelId = await loadDelegated(role, { ...spec, tier: peerTier, modelType: catalog.roles[role].modelType })
        const info = await sdk.getLoadedModelInfo({ modelId }).catch(() => null)
        const delegated = info?.isDelegated === true

        return remember(role, modelId, { ...spec, role, tier: peerTier, source: 'registry' }, delegated)
      } catch (error) {
        log.warn({ role, err: error.message }, 'delegated load failed; loading local model')
      }
    }

    const { modelId, entry } = await loadWithFallback(role)
    return remember(role, modelId, entry, false)
  })

  const unload = (role) => serial(async () => {
    const held = loaded.get(role)
    if (!held) return
    await sdk.unloadModel({ modelId: held.modelId }).catch((error) => log.warn({ role, err: error.message }, 'unload failed'))
    loaded.delete(role)
    log.info({ role }, 'model unloaded')
  })

  const release = (role) => {
    const held = loaded.get(role)
    if (!held || catalog.roles[role]?.resident) return
    held.refs -= 1
    if (held.refs > 0) return
    idleTimers.set(role, setTimeout(() => unload(role), config.idleUnloadMs).unref())
  }

  const hold = async (role, use) => {
    const modelId = await acquire(role)
    try {
      return await use(modelId)
    } finally {
      release(role)
    }
  }

  const start = async () => {
    const resources = await sdk.getSystemResources({ sample: true })
    const chosen = selectTier(resources, { ...catalog, override: config.tierOverride })

    manifest = await readManifest(config.manifestPath)
    if (!manifest) throw new Error(`no ${config.manifestPath} — ${FETCH_HINT}`)

    const tier = await provisionedTier(manifest, chosen.tier, TIERS)
    if (!tier) throw new Error(`weights for tier ${chosen.tier} are missing or truncated — ${FETCH_HINT}`)

    peer = {
      publicKey: config.forceLocal ? '' : config.providerPublicKey,
      online: false,
    }

    if (peer.publicKey) {
      peer.online = await waitForPeer({
        heartbeat: sdk.heartbeat,
        providerPublicKey: peer.publicKey,
        retries: config.heartbeatRetries,
        timeoutMs: config.heartbeatTimeoutMs,
        retryDelayMs: config.heartbeatRetryDelayMs,
        log,
      })
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

    for (const target of targetsFor(tier)) await acquire(target.role)
    state.ready = true

    return snapshot()
  }

  const stop = async () => {
    if (stopped) return
    stopped = true
    state.ready = false
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

    return { run, requestId: run.requestId, settle: () => registry.drop(run.requestId) }
  }

  const embed = (text) =>
    hold('embed', (modelId) => registry.run({ kind: 'embeddings', role: 'embed' }, () => sdk.embed({ modelId, text })))

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

  return { start, stop, acquire, release, completion, embed, transcribe, transcribeStream, speak, look, snapshot, cancel: registry.stop }
}
