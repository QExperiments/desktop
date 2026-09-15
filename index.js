import { writeFile, rm } from 'node:fs/promises'
import Fastify from 'fastify'
import { config } from './src/config.js'
import { registerConsumerRoutes } from './src/http/routes.js'
import { getSession, shutdownSession } from './src/qvac/session.js'

const fastify = Fastify({ logger: true })
registerConsumerRoutes(fastify)

const shutdown = async () => {
  try {
    await shutdownSession()
  } catch (error) {
    fastify.log.error(error)
  }
  await rm(config.pidPath, { force: true })
  try {
    await fastify.close()
  } catch {
    // already closing
  }

  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

try {
  const session = await getSession(fastify.log)

  await fastify.listen({ port: config.port, host: config.host })
  await writeFile(config.pidPath, String(process.pid), 'utf8')

  fastify.log.info(
    {
      url: `http://${config.host}:${config.port}`,
      mode: session.mode,
      model: session.modelName,
    },
    'consumer listening',
  )
} catch (error) {
  fastify.log.error(error)
  process.exit(1)
}
