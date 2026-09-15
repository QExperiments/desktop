import { heartbeat } from '@qvac/sdk'
import { config } from '../config.js'
import { logInfo, logWarn } from '../logger.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const waitForPeer = async (providerPublicKey, log = console) => {
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
