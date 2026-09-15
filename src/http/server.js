import Fastify from 'fastify'
import { config } from '../config.js'

const openaiError = (reply, code, message, type) =>
  reply.code(code).send({ error: { message, type, code } })

export const createServer = (runtime) => {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })
  const api = config.apiPrefix

  // Readiness gate. The harness polls this until it returns 200, so it must
  // stay 503 until the weights are loaded and the runtime can answer.
  app.get(`${api}/models`, (_request, reply) => {
    const state = runtime.snapshot()
    if (!state.ready) return openaiError(reply, 503, 'models are still loading', 'service_unavailable')
    return {
      object: 'list',
      data: [config.chatModel, config.embeddingModel].map((id) => ({ id, object: 'model', owned_by: 'meridian' })),
    }
  })

  app.get('/health', () => runtime.snapshot())

  // Cancellation surface for req 1.4: the UI stop button and the download
  // progress bar both post here with the requestId they were handed.
  app.post(`${api}/cancel/:requestId`, async (request, reply) => {
    const entry = await runtime.cancel(request.params.requestId)
    if (!entry) return openaiError(reply, 404, `no in-flight request ${request.params.requestId}`, 'not_found')
    return { cancelled: true, requestId: entry.requestId, kind: entry.kind, role: entry.role }
  })

  // Deliberately not a model pass-through: 6.1.1 requires retrieval, grounding
  // and tools behind this route, and those land with the RAG stage.
  app.post(`${api}/chat/completions`, (_request, reply) =>
    openaiError(reply, 501, 'chat completions arrive with the retrieval stage; this build only manages models', 'not_implemented'))

  return app
}
