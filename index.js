import { config } from './src/config.js'
import Fastify from 'fastify'

const app = Fastify({ logger: true })

// Readiness gate: the eval harness polls this path until it returns 200.
// The model runtime commit replaces the stub with the real state.
app.get(`${config.apiPrefix}/models`, (_req, reply) => reply.code(503).send({ error: { message: 'runtime not wired yet' } }))

await app.listen({ host: config.host, port: config.port })
