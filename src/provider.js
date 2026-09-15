import { close, startQVACProvider, stopQVACProvider } from '@qvac/sdk'

const seed = process.argv[2] || process.env.QVAC_HYPERSWARM_SEED

if (seed) {
  process.env.QVAC_HYPERSWARM_SEED = seed
}

console.log('starting QVAC provider (no firewall in this phase)')

try {
  const response = await startQVACProvider()
  if (!response.success || !response.publicKey) {
    throw new Error(response.error || 'startQVACProvider failed')
  }

  console.log('provider ready')
  console.log(`QVAC_PROVIDER_PUBLIC_KEY=${response.publicKey}`)
  console.log('')
  console.log('On the consumer laptop:')
  console.log(`  QVAC_PROVIDER_PUBLIC_KEY=${response.publicKey} npm start`)

  if (seed) {
    console.log('')
    console.log('Reuse this identity next time:')
    console.log(`  QVAC_HYPERSWARM_SEED=${seed} npm run provide`)
  } else {
    console.log('')
    console.log('Set QVAC_HYPERSWARM_SEED (64 hex chars) if you need a stable public key across restarts.')
  }

  console.log('')
  console.log('Ctrl+C to stop')

  const shutdown = async () => {
    console.log('\nstopping provider')

    try {
      await stopQVACProvider()
    } catch (error) {
      console.error(error)
    }

    await close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.stdin.resume()
} catch (error) {
  console.error(error)
  process.exit(1)
}
