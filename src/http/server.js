import { randomUUID } from 'node:crypto'
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { answer, kvCacheKey } from '../chat/answer.js'
import { config } from '../config.js'
import { treeRss } from '../system/rss.js'
import { registerMedia } from './media.js'
import { createSessions, isSessionId } from './sessions.js'
import { createTraces } from './trace.js'

const openaiError = (reply, code, message, type) =>
  reply.code(code).send({ error: { message, type, code } })

const headerValue = (value) => (Array.isArray(value) ? value[0] : value)

export const createServer = (runtime) => {
  // Close drops every connection, not only the idle ones: a browser that had
  // the chat page open keeps a socket Node does not count as idle, and close()
  // waited on it for good. Anything still running was cancelled just before
  // (runtime.drain in index.js).
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, forceCloseConnections: true })
  const api = config.apiPrefix
  const sessions = createSessions(config.sessionsDir)
  const traces = createTraces(config.tracesDir)

  // Every thrown error leaves in the OpenAI shape a stock client and the chat
  // page read (`error.message`), keeping the status the thrower set: a 503 for
  // a model this machine was never given, a 4xx from Fastify itself.
  app.setErrorHandler((error, request, reply) => {
    const code = error.statusCode >= 400 ? error.statusCode : 500
    if (code >= 500) request.log.error(error)
    const type = error.cancelled ? 'cancelled' : code === 503 ? 'service_unavailable' : code < 500 ? 'invalid_request_error' : 'server_error'
    return openaiError(reply, code, error.message, type)
  })

  // A session's KV-cache file is worth keeping only while the chat is likely
  // to continue. When a new session starts, the files of every session past
  // the newest few are deleted; the sessions themselves stay on disk and
  // replay from their stored messages, paying one prefill, if reopened.
  const pruneCaches = async () => {
    const stale = (await sessions.list()).slice(config.cachedSessions)
    for (const { id } of stale) await runtime.deleteCache(kvCacheKey(id))
    if (stale.length) app.log.info({ deleted: stale.length, kept: config.cachedSessions }, 'kv-cache pruned')
  }

  // Every fresh load of the chat model -- at boot, after the idle unload, on a
  // failover or a reconnect -- drops the sessions' KV files: loaded again, the
  // SDK would prefill the whole history on top of a file it no longer knows
  // the length of and double the context (see runtime freshChat). A fresh
  // file from the stored turns costs one prefill and nothing else.
  runtime.onChatLoad?.(async () => {
    const ids = (await sessions.list()).map(({ id }) => id)
    for (const id of ids) await runtime.deleteCache(kvCacheKey(id))
    if (ids.length) app.log.info({ deleted: ids.length }, 'kv-cache dropped for the freshly loaded chat model')
  })

  // Routes that need a model answer 503 until the runtime is ready: before
  // that the tier is unknown, and a request would load the wrong model or
  // fail with a 500. Also true again once a shutdown has started.
  const modelRoutes = ['/chat/', '/audio/', '/images/'].map((path) => `${api}${path}`)
  app.addHook('onRequest', async (request, reply) => {
    if (!modelRoutes.some((prefix) => request.url.startsWith(prefix)) || runtime.snapshot().ready) return
    return openaiError(reply, 503, 'models are still loading', 'service_unavailable')
  })

  app.register(multipart, { limits: { fileSize: 32 * 1024 * 1024 } })
  // The chat page and test console are optional: MERIDIAN_UI=0 leaves them out
  // at run time, `npm run build -- --no-ui` leaves ui.js (ejs, @fastify/view)
  // out of the bundle, and such a bundle logs once and serves the API alone.
  if (config.ui) {
    app.register(async (scope) => import('./ui.js')
      .then((ui) => ui.registerUi(scope, runtime))
      .catch((error) => app.log.warn({ err: error.message }, 'ui not in this build; serving the API only')))
  }
  // Turns in flight by the id the client got in x-request-id. A turn stops,
  // unsaved, when its client disconnects (a fetch aborted by the Stop button,
  // a closed tab, a timeout) or when POST /v1/cancel/<id> names it.
  const inflight = new Map()
  const track = (id, reply) => {
    const controller = new AbortController()
    inflight.set(id, controller)
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) controller.abort() })
    return { signal: controller.signal, done: () => inflight.delete(id) }
  }

  app.register(async (scope) => registerMedia(scope, runtime, sessions, track))

  app.get(`${api}/models`, (_request, reply) => {
    const state = runtime.snapshot()
    if (!state.ready) return openaiError(reply, 503, 'models are still loading', 'service_unavailable')

    return {
      object: 'list',
      data: [config.chatModel, config.embeddingModel].map((id) => ({ id, object: 'model', owned_by: 'meridian' })),
    }
  })

  // Every role and tier of models.json: what is provisioned, what the QVAC
  // registry knows (from `npm run models:list -- --refresh`) and which tiers
  // this machine's RAM affords. Read-only; downloading stays a setup step.
  app.get(`${api}/models/catalog`, () => runtime.modelCatalog())

  app.get('/health', () => runtime.snapshot())

  // Earlier chats, for the chat page. Text, voice and image turns all land here.
  app.get(`${api}/sessions`, () => sessions.list())
  app.get(`${api}/sessions/:id`, async (request, reply) =>
    (await sessions.get(request.params.id)) ?? openaiError(reply, 404, `no session ${request.params.id}`, 'not_found'))

  // Forget a chat: its stored turns and its KV-cache file. The chat page's
  // delete button lands here; so can an IT script that clears a laptop.
  app.delete(`${api}/sessions/:id`, async (request, reply) => {
    const { id } = request.params
    if (!(await sessions.remove(id))) return openaiError(reply, 404, `no session ${id}`, 'not_found')
    const cache = await runtime.deleteCache(kvCacheKey(id))
    // The direct engine keeps its own checkpoint per session; it goes too.
    if (config.retrieval.engine === 'direct') {
      await runtime.directChat().then((engine) => engine.drop(id)).catch((error) => request.log.warn(error))
    }
    request.log.info({ session: id, cache: cache?.success !== false }, 'session deleted')
    return { id, deleted: true, cache_deleted: cache?.success !== false }
  })

  app.post(`${api}/cancel/:requestId`, async (request, reply) => {
    const turn = inflight.get(request.params.requestId)
    if (turn) {
      turn.abort()
      return { cancelled: true, requestId: request.params.requestId, kind: 'turn' }
    }
    // An SDK request id straight from /health: a load, a download, one inference.
    const entry = await runtime.cancel(request.params.requestId)
    if (!entry) return openaiError(reply, 404, `no in-flight request ${request.params.requestId}`, 'not_found')
    return { cancelled: true, requestId: entry.requestId, kind: entry.kind, role: entry.role }
  })

  // I.6 -- the SDK profiler's own numbers: what each operation is made of and
  // what memory and GPU it took. Off unless MERIDIAN_PROFILE is set, and 404
  // rather than an empty body when it is off, so a reader is never handed
  // zeros that look like measurements. Nothing here carries a question, an
  // answer or a document: the export holds operation names, durations and
  // resource gauges.
  app.get(`${api}/profile`, async (_request, reply) => {
    const data = runtime.profile?.snapshot?.() ?? null
    if (!data) return openaiError(reply, 404, 'profiling is off; start serve with MERIDIAN_PROFILE=summary or verbose', 'not_found')
    return data
  })

  app.post(`${api}/chat/completions`, async (request, reply) => {
    const messages = Array.isArray(request.body?.messages) ? request.body.messages : []
    const lastUser = messages.findLastIndex((message) => message?.role === 'user')
    const query = messages[lastUser]?.content
    if (typeof query !== 'string' || query.trim() === '') {
      return openaiError(reply, 400, 'messages must end with a user message carrying text content', 'invalid_request_error')
    }
    // Only an x-session-id header names a session (see sessions.js for why the
    // OpenAI `user` field is not read). With a session the stored turns are
    // the model's history: they hold the messages exactly as the model saw
    // them, which the KV cache needs to line up, so the client's earlier turns
    // are ignored and only its last query is used. Without a session the
    // client's history goes to the model as sent, stateless like Chat
    // Completions; the chat model's ctx_size is the bound.
    const session = headerValue(request.headers['x-session-id']) || undefined
    if (session !== undefined && !isSessionId(session)) {
      return openaiError(reply, 400, 'x-session-id must be 1 to 64 characters of letters, digits, _ . or -', 'invalid_request_error')
    }
    const id = `chatcmpl-${randomUUID()}`
    const tracked = track(id, reply)
    // Held until the turn is saved; see sessions.lock.
    const unlock = session ? await sessions.lock(session) : null
    try {
      return await runTurn(request, reply, { messages, lastUser, query, session, id, signal: tracked.signal })
    } finally {
      unlock?.()
      tracked.done()
    }
  })

  const runTurn = async (request, reply, { messages, lastUser, query, session, id, signal }) => {
    const stored = session ? await sessions.context(session) : null
    const prior = stored
      ? stored.messages
      : messages.slice(0, lastUser).filter((message) => (message?.role === 'user' || message?.role === 'assistant') && typeof message.content === 'string')
    const shown = stored?.shown ?? []
    // The base the session's last turn ran with: which of the stored
    // excerpts the KV state still holds (src/chat/answer.js).
    const base = stored?.base ?? 0
    // Where the replayed conversation starts: with a turn window the last
    // trim dropped everything before it (src/chat/answer.js).
    const from = stored?.from ?? 0

    const created = Math.floor(Date.now() / 1000)
    const evalRun = headerValue(request.headers['x-eval-run'])

    // After every answer: the session turn, the eval trace when asked for, and
    // one log line of numbers. The log never carries the query or the answer.
    const settle = async (result) => {
      const rss = await treeRss()
      const stats = { ...result.stats, rss }
      if (session) {
        const turn = { kind: 'text', query, answer: result.text, citations: result.citations, messages: result.messages, shown: result.hits.filter((hit) => !hit.reused).map((hit) => hit.id), base: result.base, from: result.from, requestId: id, usage: result.usage, stats }
        // Saved before the answer ends, so the next turn reads it back.
        const saved = await sessions.append(session, turn).catch((error) => request.log.warn(error))
        if (saved?.turns.length === 1) pruneCaches().catch((error) => request.log.warn(error))
      }
      if (evalRun) {
        const trace = { id, run: evalRun, session: session ?? null, at: new Date().toISOString(), query, text: result.text, citations: result.citations, hits: result.hits, messages: result.messages, rounds: result.rounds, retrieval: result.retrieval, usage: result.usage, stats }
        await traces.write(evalRun, id, trace).catch((error) => request.log.warn(error))
      }
      const { tool_calls, ...numbers } = stats
      request.log.info({ id, session: session ?? null, usage: result.usage, stats: { ...numbers, tool_calls: tool_calls.map((call) => call.name) } }, 'chat')
      return stats
    }

    const generationParams = {}

    if (typeof request.body?.temperature === 'number') generationParams.temp = request.body.temperature
    if (Number.isInteger(request.body?.seed)) generationParams.seed = request.body.seed

    reply.header('x-request-id', id)

    if (request.body?.stream) {
      // OpenAI SSE: one `chat.completion.chunk` per token; citations, `grounded`,
      // `usage` and `stats` ride on the final chunk, then `[DONE]`.
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-request-id': id })
      const send = (payload) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
      const chunk = (delta, finish_reason = null, extra = {}) =>
        send({ id, object: 'chat.completion.chunk', created, model: config.chatModel, choices: [{ index: 0, delta, finish_reason }], ...extra })
      try {
        let first = true
        const result = await answer(runtime, {
          messages: [...prior, { role: 'user', content: query }],
          session,
          shown,
          base,
          from,
          generationParams,
          signal,
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
        const stats = await settle(result)
        chunk({ citations }, 'stop', { grounded: citations.length > 0, usage: result.usage, stats })
      } catch (error) {
        if (!error.cancelled) request.log.error(error)
        send({ error: { message: error.message, type: error.cancelled ? 'cancelled' : 'server_error' } })
      }
      reply.raw.write('data: [DONE]\n\n')
      reply.raw.end()
      return reply
    }

    const result = await answer(runtime, { messages: [...prior, { role: 'user', content: query }], session, shown, base, from, generationParams, signal })
    const { text, citations } = result
    const stats = await settle(result)

    return {
      id,
      object: 'chat.completion',
      created,
      model: config.chatModel,
      choices: [{ index: 0, message: { role: 'assistant', content: text, citations }, finish_reason: 'stop' }],
      grounded: citations.length > 0,
      usage: result.usage,
      stats,
    }
  }

  return app
}
