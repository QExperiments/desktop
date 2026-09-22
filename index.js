import { writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from './src/config.js'
import { createServer } from './src/http/server.js'
import { createRuntime } from './src/runtime/index.js'

const runtime = createRuntime()
const app = createServer(runtime)

// `serve:stop` can land more than one signal. Without the latch the second
// call runs past `runtime.stop()` -- which returns at once, being already
// stopped -- and exits the process while the first is still unloading the
// models and writing the profile.
let closing = null
const shutdown = (signal) => {
  app.log.info({ signal }, 'shutting down')
  closing ??= (async () => {
    await app.close().catch((error) => app.log.error(error))
    await runtime.stop().catch((error) => app.log.error(error))
    await rm(config.pidPath, { force: true })
    process.exit(0)
  })()
  return closing
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal))

try {
  // Listen before loading: the harness can then poll /v1/models and watch it
  // turn from 503 into 200 instead of waiting on a refused connection.
  await app.listen({ host: config.host, port: config.port })
  await mkdir(dirname(config.pidPath), { recursive: true })
  await writeFile(config.pidPath, `${process.pid}\n`)
  const state = await runtime.start()
  app.log.info({ tier: state.tier, models: state.models }, 'ready')
} catch (error) {
  app.log.error(error)
  await runtime.stop().catch(() => {})
  await rm(config.pidPath, { force: true })
  process.exit(1)
}
