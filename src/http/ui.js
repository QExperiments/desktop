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

  // Test console for the APIs this build already exposes. Not the product UI.
  const page = async (_request, reply) =>
    reply.view('index', {
      apiPrefix: config.apiPrefix,
      snapshot: runtime.snapshot(),
    })

  app.get('/', page)
  app.get('/ui', page)
}
