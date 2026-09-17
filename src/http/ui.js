import { fileURLToPath } from 'node:url'
import ejs from 'ejs'
import view from '@fastify/view'
import { config } from '../config.js'

const viewsRoot = fileURLToPath(new URL('../../views', import.meta.url))

export const registerUi = async (app, runtime) => {
  await app.register(view, {
    engine: { ejs },
    root: viewsRoot,
    viewExt: 'ejs',
  })

  const render = (name) => async (_request, reply) =>
    reply.view(name, { apiPrefix: config.apiPrefix, snapshot: runtime.snapshot() })

  // `/` is the chat; `/ui` keeps the test console for the other APIs.
  app.get('/', render('chat'))
  app.get('/ui', render('index'))
}
