const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const DELEGATED_ROLES = new Set(['chat', 'asr', 'tts'])

export const waitForPeer = async ({
  heartbeat,
  providerPublicKey,
  retries,
  timeoutMs,
  retryDelayMs,
  log,
}) => {
  if (!providerPublicKey) return false
  let lastError

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await heartbeat({
        delegate: {
          providerPublicKey,
          timeout: timeoutMs,
        },
      })

      log.info({ attempt, providerPublicKey }, 'provider heartbeat ok')
      return true
    } catch (error) {
      lastError = error
      log.warn({ attempt, err: error.message }, 'provider heartbeat failed')

      if (attempt < retries) await sleep(retryDelayMs)
    }
  }

  log.warn({ err: lastError?.message }, 'provider unreachable after retries; using local inference')

  return false
}
