const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// I.1.2 / I.1.3 heartbeat and swap policy. Live checklist: docs-final/p2p-test.md
export const DELEGATED_ROLES = new Set(['chat', 'asr', 'tts'])

export const waitForPeer = async ({
  heartbeat,
  providerPublicKey,
  retries,
  timeoutMs,
  retryDelayMs,
  log,
  logOk = true,
  giveUpMessage = 'provider unreachable after retries; using local inference',
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

      if (logOk) log.info({ attempt, providerPublicKey }, 'provider heartbeat ok')
      return true
    } catch (error) {
      lastError = error
      log.warn({ attempt, err: error.message }, 'provider heartbeat failed')

      if (attempt < retries) await sleep(retryDelayMs)
    }
  }

  if (giveUpMessage) log.warn({ err: lastError?.message }, giveUpMessage)

  return false
}

export const peerSwapBlocked = (loaded, roles = loaded.keys()) => {
  const wanted = roles instanceof Set ? roles : new Set(roles)
  return [...loaded.entries()].some(([role, held]) => wanted.has(role) && (held.pins ?? 0) > 0)
}

export const createPeerMonitor = ({
  heartbeat,
  providerPublicKey,
  retries,
  timeoutMs,
  retryDelayMs,
  intervalMs,
  log,
  onOnline,
  onOffline,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) => {
  let timer = null
  let stopped = false
  let online = false
  let probing = false

  const probe = ({ startup = false } = {}) => waitForPeer({
    heartbeat,
    providerPublicKey,
    retries: startup ? retries : 1,
    timeoutMs,
    retryDelayMs: startup ? retryDelayMs : 0,
    log,
    logOk: startup,
    giveUpMessage: startup ? 'provider unreachable after retries; using local inference' : '',
  })

  const tick = async () => {
    if (stopped || probing || !providerPublicKey) return
    probing = true

    try {
      const ok = await probe()

      if (ok && !online) {
        await onOnline?.()
        online = true
      } else if (!ok && online) {
        try {
          await onOffline?.()
        } finally {
          online = false
        }
      }
    } catch (error) {
      log.warn({ err: error.message }, 'provider health check failed')
    } finally {
      probing = false
    }
  }

  return {
    start: async () => {
      online = providerPublicKey ? await probe({ startup: true }) : false
      return online
    },
    watch: () => {
      if (stopped || !providerPublicKey || !(intervalMs > 0) || timer) return
      timer = setIntervalFn(() => { void tick() }, intervalMs)
      timer.unref?.()
    },
    stop: () => {
      stopped = true
      if (timer != null) clearIntervalFn(timer)
      timer = null
    },
    tick,
    get online() {
      return online
    },
  }
}
