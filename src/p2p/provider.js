import { close, startQVACProvider, stopQVACProvider } from '@qvac/sdk'
import { logger } from '../logger.js'
import { parseFirewall, parsePublicKeys } from './firewall.js'

// I.1.1 allow/deny by consumer public key. Live checklist: docs/p2p-test.md

const seed = process.argv[2] || process.env.QVAC_HYPERSWARM_SEED

if (seed) {
  process.env.QVAC_HYPERSWARM_SEED = seed
}

const firewall = parseFirewall({
  mode: process.env.QVAC_FIREWALL_MODE,
  publicKeys: [...parsePublicKeys(process.env.QVAC_FIREWALL_PUBLIC_KEYS), ...process.argv.slice(3)],
})

if (firewall) {
  logger.info({ mode: firewall.mode, consumers: firewall.publicKeys.length }, 'starting P2P inference provider')
} else {
  logger.info('starting P2P inference provider (open: set QVAC_FIREWALL_PUBLIC_KEYS to allow only known laptops)')
}

try {
  const response = await startQVACProvider(firewall ? { firewall } : {})
  if (!response.success || !response.publicKey) {
    throw new Error(response.error || 'startQVACProvider failed')
  }

  logger.info({ publicKey: response.publicKey }, 'P2P inference provider ready')
  logger.info(
    { consumer: `QVAC_PROVIDER_PUBLIC_KEY=${response.publicKey} npm run serve` },
    'on the consumer laptop',
  )

  if (firewall) {
    logger.info({ mode: firewall.mode, publicKeys: firewall.publicKeys }, 'provider firewall')
  }

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
