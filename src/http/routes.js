import { completion } from '@qvac/sdk'
import { config } from '../config.js'
import { getSession } from '../qvac/session.js'

function toHistory(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [{ role: 'user', content: 'Hello' }]
  }

  return messages.map((message) => ({
    role: message.role === 'assistant' || message.role === 'system' ? message.role : 'user',
    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
  }))
}

export async function registerConsumerRoutes(fastify) {
  fastify.get('/', async () => ({ ok: true, service: 'meridian-consumer' }))

  fastify.get('/health', async () => {
    const session = await getSession(fastify.log)
    return { ok: true, ...session }
  })

  async function modelsPayload() {
    const session = await getSession(fastify.log)
    return {
      object: 'list',
      data: [
        {
          id: config.chatModel,
          object: 'model',
          owned_by: 'meridian',
          qvacModelId: session.modelId,
          delegated: session.isDelegated,
        },
      ],
    }
  }

  fastify.get('/models', modelsPayload)
  fastify.get('/v1/models', modelsPayload)

  fastify.post('/v1/chat/completions', async (request, reply) => {
    const session = await getSession(fastify.log)
    const body = request.body ?? {}
    const stream = Boolean(body.stream)
    const history = toHistory(body.messages)
    const run = completion({
      modelId: session.modelId,
      history,
      stream,
      temp: typeof body.temperature === 'number' ? body.temperature : undefined,
      seed: typeof body.seed === 'number' ? body.seed : undefined,
    })

    if (stream) {
      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const id = `chatcmpl-${Date.now()}`
      for await (const event of run.events) {
        if (event.type !== 'contentDelta' || !event.text) continue
        const chunk = {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model || config.chatModel,
          choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
        }
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      reply.raw.write('data: [DONE]\n\n')
      reply.raw.end()
      return reply
    }

    const final = await run.final
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || config.chatModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: final.contentText,
            citations: [],
          },
          finish_reason: 'stop',
        },
      ],
    }
  })
}
