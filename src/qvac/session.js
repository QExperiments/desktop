import {
  close,
  getLoadedModelInfo,
  getSystemResources,
  loadModel,
  unloadModel,
} from '@qvac/sdk'
import { config } from '../config.js'
import { logInfo, logWarn } from '../logger.js'
import { waitForPeer } from './peer.js'
import { describeResources, selectModel } from './select-model.js'

let sessionPromise

const progressLogger = (log) => (p) => {
  const mb = (n) => (n / 1e6).toFixed(1)
  const pct = Number(p.percentage ?? 0)
  const line = `model download ${pct.toFixed(0)}% (${mb(p.downloaded ?? 0)}/${mb(p.total ?? 0)} MB)`
  logInfo(log, { percentage: pct }, line)
}

const loadOnce = ({ modelSrc, delegate, log }) =>
  loadModel({
    modelSrc,
    delegate,
    onProgress: progressLogger(log),
  })

const startSession = async (log = console) => {
  const resources = await getSystemResources({ sample: true })
  const hardware = describeResources(resources)
  const localPick = selectModel(resources)
  const providerPublicKey = config.forceLocal ? '' : config.providerPublicKey

  logInfo(
    log,
    { hardware, localModel: localPick.id, reason: localPick.reason, forceLocal: config.forceLocal },
    'selected local-capable model',
  )

  let peerOnline = false
  if (providerPublicKey) {
    peerOnline = await waitForPeer(providerPublicKey, log)
  }

  const peerPick = peerOnline
    ? selectModel(resources, { assumeStrongPeer: config.assumeStrongPeer })
    : localPick
  const sameAsLocal = peerPick.id === localPick.id

  let modelId
  let mode = 'local'

  if (peerOnline) {
    try {
      modelId = await loadOnce({
        modelSrc: peerPick.modelSrc,
        log,
        delegate: {
          providerPublicKey,
          timeout: config.delegateTimeoutMs,
          fallbackToLocal: sameAsLocal,
        },
      })
      mode = 'delegated'
    } catch (error) {
      logWarn(log, { err: error }, 'delegated loadModel failed; loading local model')
      modelId = await loadOnce({ modelSrc: localPick.modelSrc, log })
      mode = 'local-fallback'
    }
  } else {
    modelId = await loadOnce({ modelSrc: localPick.modelSrc, log })
    mode = providerPublicKey ? 'local-fallback' : 'local'
  }

  let info
  try {
    info = await getLoadedModelInfo({ modelId })
  } catch {
    info = null
  }

  const isDelegated = info?.isDelegated === true
  const selected = isDelegated ? peerPick : localPick
  const session = {
    modelId,
    mode: isDelegated ? 'delegated' : mode,
    isDelegated,
    modelName: selected.id,
    hardware,
    providerPublicKey: isDelegated ? providerPublicKey : null,
  }

  logInfo(log, session, 'chat model ready')
  return session
}

export const getSession = (log) => {
  if (!sessionPromise) {
    sessionPromise = startSession(log)
  }
  return sessionPromise
}

export const shutdownSession = async () => {
  if (!sessionPromise) {
    await close()
    return
  }

  try {
    const session = await sessionPromise
    await unloadModel({ modelId: session.modelId })
  } catch {
    // already gone
  } finally {
    sessionPromise = undefined
    await close()
  }
}
