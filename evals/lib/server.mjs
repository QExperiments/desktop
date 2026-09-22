import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

// Spawns `node index.js` the way qvac-eval.json's `start` does, on the eval
// port and tier, and waits for /v1/models to turn 200: that wait is the
// cold start the harness reports. stop() sends SIGTERM so the server unloads
// its models and closes the SDK, which is when memory should return to base.
export const startServer = async ({ port, tier, cwd, logPath, readyTimeoutMs = 600_000, env = {} }) => {
  const startedAt = Date.now()
  const child = spawn(process.execPath, ['index.js'], {
    cwd,
    env: { ...process.env, PORT: String(port), MERIDIAN_TIER: tier, LOG_LEVEL: 'info', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = createWriteStream(logPath, { flags: 'a' })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  let exited = null
  child.on('exit', (code, signal) => { exited = { code, signal } })

  const base = `http://127.0.0.1:${port}`
  while (Date.now() - startedAt < readyTimeoutMs) {
    if (exited) throw new Error(`serve exited during start (code ${exited.code}, signal ${exited.signal}); see ${logPath}`)
    const status = await fetch(`${base}/v1/models`).then((r) => r.status, () => 0)
    if (status === 200) break
    await sleep(500)
  }
  if (exited) throw new Error(`serve exited during start; see ${logPath}`)
  const coldStartMs = Date.now() - startedAt
  if (coldStartMs >= readyTimeoutMs) {
    child.kill('SIGKILL')
    throw new Error(`serve not ready after ${readyTimeoutMs} ms; see ${logPath}`)
  }

  const health = () => fetch(`${base}/health`).then((r) => r.json())

  const stop = async () => {
    if (exited) return exited
    child.kill('SIGTERM')
    const deadline = Date.now() + 60_000
    while (!exited && Date.now() < deadline) await sleep(200)
    if (!exited) child.kill('SIGKILL')
    while (!exited) await sleep(100)
    log.end()
    return exited
  }

  return { pid: child.pid, base, coldStartMs, health, stop }
}
