import { heartbeat } from '@qvac/sdk'
import { config } from './config.js'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function logInfo(log, obj, msg) {
  if (typeof log?.info === 'function') log.info(obj, msg)
  else console.log(msg, obj)
}

function logWarn(log, obj, msg) {
  if (typeof log?.warn === 'function') log.warn(obj, msg)
  else console.warn(msg, obj)
}

/**
 * Cheap reachability check before a 60s delegated loadModel (I.1.2).
 * Returns true only if the provider answers heartbeat within the retry budget.
 */
export async function waitForPeer(providerPublicKey, log = console) {
  if (!providerPublicKey) return false

  let lastError
  for (let attempt = 1; attempt <= config.heartbeatRetries; attempt += 1) {
    try {
      await heartbeat({
        delegate: {
          providerPublicKey,
          timeout: config.heartbeatTimeoutMs,
        },
      })
      logInfo(log, { attempt, providerPublicKey }, 'provider heartbeat ok')
      return true
    } catch (error) {
      lastError = error
      logWarn(log, { attempt, err: error }, 'provider heartbeat failed')
      if (attempt < config.heartbeatRetries) {
        await sleep(config.heartbeatRetryDelayMs)
      }
    }
  }

  logWarn(log, { err: lastError }, 'provider unreachable after retries; using local inference')
  return false
}
