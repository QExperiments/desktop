const GiB = 1024 ** 3

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 11434),
  chatModel: 'meridian-assistant',
  providerPublicKey: process.env.QVAC_PROVIDER_PUBLIC_KEY?.trim() || '',
  forceLocal: process.env.QVAC_FORCE_LOCAL === '1',
  assumeStrongPeer: process.env.QVAC_ASSUME_STRONG_PEER === '1',
  heartbeatRetries: Number(process.env.QVAC_PEER_HEARTBEAT_RETRIES ?? 3),
  heartbeatTimeoutMs: Number(process.env.QVAC_PEER_HEARTBEAT_TIMEOUT_MS ?? 15_000),
  heartbeatRetryDelayMs: Number(process.env.QVAC_PEER_HEARTBEAT_RETRY_DELAY_MS ?? 1000),
  delegateTimeoutMs: Number(process.env.QVAC_DELEGATE_TIMEOUT_MS ?? 60_000),
  pidPath: new URL('../.meridian-serve.pid', import.meta.url),
}

export { GiB }
