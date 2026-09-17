import { randomUUID } from 'node:crypto'
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { answer } from '../chat/answer.js'
import { config } from '../config.js'
import { registerMedia } from './media.js'
import { createSessions } from './sessions.js'
import { registerUi } from './ui.js'

const openaiError = (reply, code, message, type) =>
  reply.code(code).send({ error: { message, type, code } })

export const createServer = (runtime) => {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })
  const api = config.apiPrefix
  const sessions = createSessions(config.sessionsDir)

  app.register(multipart, { limits: { fileSize: 32 * 1024 * 1024 } })
  app.register(async (scope) => registerUi(scope, runtime))
  app.register(async (scope) => registerMedia(scope, runtime, sessions))

  app.get(`${api}/models`, (_request, reply) => {
    const state = runtime.snapshot()
    if (!state.ready) return openaiError(reply, 503, 'models are still loading', 'service_unavailable')

    return {
      object: 'list',
      data: [config.chatModel, config.embeddingModel].map((id) => ({ id, object: 'model', owned_by: 'meridian' })),
    }
  })

  app.get('/health', () => runtime.snapshot())

  // Earlier chats, for the chat page. Text, voice and image turns all land here.
  app.get(`${api}/sessions`, () => sessions.list())
  app.get(`${api}/sessions/:id`, async (request, reply) =>
    (await sessions.get(request.params.id)) ?? openaiError(reply, 404, `no session ${request.params.id}`, 'not_found'))

  app.post(`${api}/cancel/:requestId`, async (request, reply) => {
    const entry = await runtime.cancel(request.params.requestId)
    if (!entry) return openaiError(reply, 404, `no in-flight request ${request.params.requestId}`, 'not_found')
    return { cancelled: true, requestId: entry.requestId, kind: entry.kind, role: entry.role }
  })

  app.post(`${api}/chat/completions`, async (request, reply) => {
    const messages = Array.isArray(request.body?.messages) ? request.body.messages : []
    const lastUser = messages.findLastIndex((message) => message?.role === 'user')
    const query = messages[lastUser]?.content
    if (typeof query !== 'string' || query.trim() === '') {
      return openaiError(reply, 400, 'messages must end with a user message carrying text content', 'invalid_request_error')
    }
    // A session key (OpenAI's `user` field or an x-session-id header) lets the
    // SDK keep the KV state between calls. With a session the stored turns are
    // the model's history: they hold the messages exactly as the model saw
    // them, which the cache needs to line up, so the client's earlier turns are
    // ignored and only its last query is used. Without a session the client's
    // history goes to the model as sent; the chat model's ctx_size is the bound.
    const header = request.headers['x-session-id']
    const session = typeof request.body?.user === 'string' ? request.body.user : Array.isArray(header) ? header[0] : header
    const stored = session ? await sessions.context(session) : null
    const prior = stored
      ? stored.messages
      : messages.slice(0, lastUser).filter((message) => (message?.role === 'user' || message?.role === 'assistant') && typeof message.content === 'string')
    const shown = stored?.shown ?? []
    const remember = ({ text, citations, messages: added, hits }) => {
      if (!session) return
      const turn = { kind: 'text', query, answer: text, citations, messages: added, shown: hits.filter((hit) => !hit.reused).map((hit) => hit.id) }
      sessions.append(session, turn).catch((error) => request.log.warn(error))
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
        const result = await answer(runtime, {
          messages: [...prior, { role: 'user', content: query }],
          session,
          shown,
          generationParams,
          onDelta: (content) => {
            if (first && content.trim() === '') return // the model's leading blank lines
            if (first) chunk({ role: 'assistant' })
            first = false
            chunk({ content })
          },
        })
        const { text, citations } = result
        // Nothing streamed (the model wrote no prose) but answer() still has text.
        if (first && text) {
          chunk({ role: 'assistant' })
          chunk({ content: text })
        }
        chunk({ citations }, 'stop', { grounded: citations.length > 0 })
        remember(result)
      } catch (error) {
        request.log.error(error)
        send({ error: { message: error.message, type: 'server_error' } })
      }
      reply.raw.write('data: [DONE]\n\n')
      reply.raw.end()
      return reply
    }

    const result = await answer(runtime, { messages: [...prior, { role: 'user', content: query }], session, shown, generationParams })
    const { text, citations } = result
    remember(result)

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
