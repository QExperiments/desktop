import { readFile, rm } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { config } from './config.js'
import { logger } from './logger.js'

// Unloading the models and writing the profile takes a few seconds; a turn
// that was generating is cancelled first. Past this, serve is killed.
const GRACE_MS = Number(process.env.MERIDIAN_STOP_GRACE_MS ?? 60_000)

const pid = Number((await readFile(config.pidPath, 'utf8').catch(() => '')).trim())

if (!Number.isInteger(pid) || pid <= 0) {
  logger.warn({ pidPath: config.pidPath }, 'no pid file; serve does not look like it is running')
  process.exit(0)
}

const alive = () => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

try {
  // SIGTERM, not SIGKILL: serve has to unload the models and close the SDK.
  process.kill(pid, 'SIGTERM')
  logger.info({ pid }, 'asked serve to stop')
} catch (error) {
  if (error.code !== 'ESRCH') throw error
  logger.warn({ pid }, 'serve was already gone')
}

// The harness takes the return of `serve:stop` as the models being out of
// memory, so it returns only once the process has exited.
const deadline = Date.now() + GRACE_MS
while (alive() && Date.now() < deadline) await sleep(200)

if (alive()) {
  logger.warn({ pid, graceMs: GRACE_MS }, 'serve did not stop in time; killing it')
  process.kill(pid, 'SIGKILL')
} else {
  logger.info({ pid }, 'serve stopped')
}

// serve removes its own pid file on the way out; this covers a crash or a kill.
await rm(config.pidPath, { force: true })
