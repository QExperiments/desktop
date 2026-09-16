import { randomUUID } from 'node:crypto'
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { answer } from '../chat/answer.js'
import { config } from '../config.js'
import { registerMedia } from './media.js'

const openaiError = (reply, code, message, type) =>
  reply.code(code).send({ error: { message, type, code } })

export const createServer = (runtime) => {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })
  const api = config.apiPrefix

  app.register(multipart, { limits: { fileSize: 32 * 1024 * 1024 } })
  app.register(async (scope) => registerMedia(scope, runtime))

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
  // and tools behind this route, and those land with the RAG stage. Until then
  // the route refuses, unless MERIDIAN_UNGROUNDED=1 asks for the ungrounded
  // answer for local testing. That answer does not satisfy 6.1.1 and the flag
  // is never set by `serve`, the eval harness or CI.
  app.post(`${api}/chat/completions`, async (request, reply) => {
    if (process.env.MERIDIAN_UNGROUNDED !== '1') {
      return openaiError(reply, 501, 'chat completions arrive with the retrieval stage; this build only manages models', 'not_implemented')
    }

    const messages = Array.isArray(request.body?.messages) ? request.body.messages : []
    const question = messages.filter((message) => message?.role === 'user').at(-1)?.content
    if (typeof question !== 'string' || question.trim() === '') {
      return openaiError(reply, 400, 'messages must end with a user message carrying text content', 'invalid_request_error')
    }
    if (request.body?.stream) {
      return openaiError(reply, 501, 'streaming arrives with the retrieval stage', 'not_implemented')
    }

    // Req 6.1.3 asks the route to honour both, so they are wired even on the
    // ungrounded path: a seeded run is what makes two attempts comparable.
    const generationParams = {}
    if (typeof request.body?.temperature === 'number') generationParams.temp = request.body.temperature
    if (Number.isInteger(request.body?.seed)) generationParams.seed = request.body.seed

    const { text, citations } = await answer(runtime, { question, generationParams })

    return {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: config.chatModel,
      // The array 6.1.2 requires is here and empty, which is the honest report:
      // nothing was retrieved because retrieval does not exist yet.
      choices: [{ index: 0, message: { role: 'assistant', content: text, citations }, finish_reason: 'stop' }],
      grounded: false,
    }
  })

  return app
}
