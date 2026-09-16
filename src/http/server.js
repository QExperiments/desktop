import { randomUUID } from 'node:crypto'
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { answer } from '../chat/answer.js'
import { config } from '../config.js'
import { registerMedia } from './media.js'
import { registerUi } from './ui.js'

const openaiError = (reply, code, message, type) =>
  reply.code(code).send({ error: { message, type, code } })

export const createServer = (runtime) => {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })
  const api = config.apiPrefix

  app.register(multipart, { limits: { fileSize: 32 * 1024 * 1024 } })
  app.register(async (scope) => registerUi(scope, runtime))
  app.register(async (scope) => registerMedia(scope, runtime))

  app.get(`${api}/models`, (_request, reply) => {
    const state = runtime.snapshot()
    if (!state.ready) return openaiError(reply, 503, 'models are still loading', 'service_unavailable')

    return {
      object: 'list',
      data: [config.chatModel, config.embeddingModel].map((id) => ({ id, object: 'model', owned_by: 'meridian' })),
    }
  })

  app.get('/health', () => runtime.snapshot())

  app.post(`${api}/cancel/:requestId`, async (request, reply) => {
    const entry = await runtime.cancel(request.params.requestId)
    if (!entry) return openaiError(reply, 404, `no in-flight request ${request.params.requestId}`, 'not_found')
    return { cancelled: true, requestId: entry.requestId, kind: entry.kind, role: entry.role }
  })

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

    const generationParams = {}

    if (typeof request.body?.temperature === 'number') generationParams.temp = request.body.temperature
    if (Number.isInteger(request.body?.seed)) generationParams.seed = request.body.seed

    const { text, citations } = await answer(runtime, { question, generationParams })

    return {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: config.chatModel,
      choices: [{ index: 0, message: { role: 'assistant', content: text, citations }, finish_reason: 'stop' }],
      grounded: false,
    }
  })

  return app
}
