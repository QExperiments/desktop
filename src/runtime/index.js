// The only module that imports @qvac/sdk. Everything above it talks to this
// interface, which is what keeps the HTTP layer from becoming a model proxy.
import * as sdk from '@qvac/sdk'
import { config } from '../config.js'
import { createCancelRegistry } from './cancel.js'
import { selectTier } from './capability.js'
import { catalog, entryFor, provisionedTier, readManifest, targetsFor } from './models.js'
import { logger } from '../logger.js'

const TIERS = ['L', 'M', 'S']
const FETCH_HINT = 'run `npm run models:fetch`'

export const createRuntime = ({ log = logger } = {}) => {
  const registry = createCancelRegistry({ cancel: sdk.cancel })
  const loaded = new Map()
  let manifest = null
  let state = { ready: false, tier: null, hardware: null, reason: null }
  let chain = Promise.resolve()
  let stopped = false

  // Loads are serialized: two large models decoding into 8 GB at once is how
  // the target laptop gets killed by the OOM reaper.
  const serial = (task) => {
    const next = chain.then(task, task)
    chain = next.then(() => {}, () => {})
    return next
  }

  const load = (entry) =>
    registry.run({ kind: 'load', role: entry.role, tier: entry.tier }, () =>
      sdk.loadModel(entry.source === 'registry'
        ? { modelSrc: sdk[entry.constant] }
        : { modelSrc: entry.path, modelType: entry.modelType }))

  // Degradation instead of failure: if the tier's model will not load, drop to
  // the next smaller one that is actually on disk before giving up.
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

  const acquire = (role) => serial(async () => {
    const held = loaded.get(role)
    if (held) {
      held.refs += 1
      return held.modelId
    }
    const { modelId, entry } = await loadWithFallback(role)
    loaded.set(role, { modelId, entry, refs: 1 })
    log.info({ role, modelId, tier: entry.tier, source: entry.source }, 'model loaded')
    return modelId
  })

  const release = (role) => serial(async () => {
    const held = loaded.get(role)
    if (!held || catalog.roles[role]?.resident) return
    held.refs -= 1
    if (held.refs > 0) return
    await sdk.unloadModel({ modelId: held.modelId })
    loaded.delete(role)
    log.info({ role }, 'model unloaded')
  })

  const start = async () => {
    const resources = await sdk.getSystemResources({ sample: true })
    const chosen = selectTier(resources, { ...catalog, override: config.tierOverride })
    manifest = await readManifest(config.manifestPath)
    if (!manifest) throw new Error(`no ${config.manifestPath} — ${FETCH_HINT}`)

    // Prefer the tier this machine deserves, but accept whatever was actually
    // provisioned: a fleet laptop may be handed a bundle built elsewhere.
    const tier = await provisionedTier(manifest, chosen.tier, TIERS)
    if (!tier) throw new Error(`weights for tier ${chosen.tier} are missing or truncated — ${FETCH_HINT}`)

    state = { ...state, tier, hardware: chosen.hardware, reason: chosen.reason }
    log.info({ tier, chosen: chosen.tier, reason: chosen.reason, hardware: chosen.hardware }, 'runtime starting')

    for (const target of targetsFor(tier)) await acquire(target.role)
    state.ready = true
    return snapshot()
  }

  const stop = async () => {
    if (stopped) return
    stopped = true
    state.ready = false
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

  const embed = async (text) => {
    const modelId = await acquire('embed')
    return registry.run({ kind: 'embeddings', role: 'embed' }, () => sdk.embed({ modelId, text }))
  }

  const snapshot = () => ({
    ...state,
    models: [...loaded].map(([role, held]) => ({ role, modelId: held.modelId, tier: held.entry.tier, source: held.entry.source, constant: held.entry.constant })),
    inflight: registry.list().map(({ abort, ...rest }) => rest),
  })

  return { start, stop, acquire, release, completion, embed, snapshot, cancel: registry.stop }
}
