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
    const messages = Array.isArray(request.body?.messages) ? request.body.messages : []
    const question = messages.filter((message) => message?.role === 'user').at(-1)?.content
    if (typeof question !== 'string' || question.trim() === '') {
      return openaiError(reply, 400, 'messages must end with a user message carrying text content', 'invalid_request_error')
    }
    const generationParams = {}

    if (typeof request.body?.temperature === 'number') generationParams.temp = request.body.temperature
    if (Number.isInteger(request.body?.seed)) generationParams.seed = request.body.seed

    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)

    if (request.body?.stream) {
      // OpenAI SSE: one `chat.completion.chunk` per token, citations and
      // `grounded` ride on the final chunk, then `[DONE]`.
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = (payload) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
      const chunk = (delta, finish_reason = null, extra = {}) =>
        send({ id, object: 'chat.completion.chunk', created, model: config.chatModel, choices: [{ index: 0, delta, finish_reason }], ...extra })
      try {
        let first = true
        const { citations } = await answer(runtime, {
          question,
          generationParams,
          onDelta: (content) => {
            if (first && content.trim() === '') return // the model's leading blank lines
            if (first) chunk({ role: 'assistant' })
            first = false
            chunk({ content })
          },
        })
        chunk({ citations }, 'stop', { grounded: citations.length > 0 })
      } catch (error) {
        request.log.error(error)
        send({ error: { message: error.message, type: 'server_error' } })
      }
      reply.raw.write('data: [DONE]\n\n')
      reply.raw.end()
      return reply
    }

    const { text, citations } = await answer(runtime, { question, generationParams })

    return {
      id,
      object: 'chat.completion',
      created,
      model: config.chatModel,
      choices: [{ index: 0, message: { role: 'assistant', content: text, citations }, finish_reason: 'stop' }],
      grounded: citations.length > 0,
    }
  })

  return app
}
