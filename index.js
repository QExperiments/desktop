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
// The pid file is ours only once this process wrote it. A second `serve` that
// fails with EADDRINUSE must leave the running server's file alone, or
// `serve:stop` can no longer find it.
let ownsPid = false
const dropPid = () => (ownsPid ? rm(config.pidPath, { force: true }) : undefined)

// The SDK's own SIGTERM handler kills its Bare worker first and raises the
// signal again (hence two "shutting down" lines). The unloads below then talk
// to a dead worker; most fail at once, but one was seen to never settle, and
// serve hung until `serve:stop` killed it. The models went with the worker, so
// past this grace the process just exits.
const SHUTDOWN_GRACE_MS = 10_000

const shutdown = (signal) => {
  app.log.info({ signal }, 'shutting down')
  closing ??= (async () => {
    setTimeout(() => {
      app.log.warn({ graceMs: SHUTDOWN_GRACE_MS }, 'shutdown did not finish in time; exiting')
      Promise.resolve(dropPid()).finally(() => process.exit(0))
    }, SHUTDOWN_GRACE_MS).unref()
    // Cancel what is generating first: app.close() waits for open requests,
    // and a turn left running would hold the models for as long as it takes.
    await runtime.drain().catch((error) => app.log.error(error))
    await app.close().catch((error) => app.log.error(error))
    await runtime.stop().catch((error) => app.log.error(error))
    await dropPid()
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
  ownsPid = true
  const state = await runtime.start()
  app.log.info({ tier: state.tier, models: state.models }, 'ready')
} catch (error) {
  app.log.error(error)
  await runtime.stop().catch(() => {})
  await dropPid()
  process.exit(1)
}
