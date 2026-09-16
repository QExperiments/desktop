import { close, startQVACProvider, stopQVACProvider } from '@qvac/sdk'
import { logger } from '../logger.js'

const seed = process.argv[2] || process.env.QVAC_HYPERSWARM_SEED

if (seed) {
  process.env.QVAC_HYPERSWARM_SEED = seed
}

logger.info('starting P2P inference provider (no firewall in this phase)')

try {
  const response = await startQVACProvider()
  if (!response.success || !response.publicKey) {
    throw new Error(response.error || 'startQVACProvider failed')
  }

  logger.info({ publicKey: response.publicKey }, 'P2P inference provider ready')
  logger.info(
    { consumer: `QVAC_PROVIDER_PUBLIC_KEY=${response.publicKey} npm run serve` },
    'on the consumer laptop',
  )

  if (seed) {
    logger.info(
      { reuse: `QVAC_HYPERSWARM_SEED=${seed} npm run provide` },
      'reuse this identity next time',
    )
  } else {
    logger.info('set QVAC_HYPERSWARM_SEED (64 hex chars) if you need a stable public key across restarts')
  }

  logger.info('Ctrl+C to stop')

  const shutdown = async () => {
    logger.info('stopping P2P inference provider')

    try {
      await stopQVACProvider()
    } catch (error) {
      logger.error({ err: error.message }, 'stopQVACProvider failed')
    }

    await close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.stdin.resume()
} catch (error) {
  logger.error({ err: error.message }, 'P2P inference provider failed')
  process.exit(1)
}
