import { readFile, rm } from 'node:fs/promises'
import { config } from './config.js'
import { logger } from './logger.js'

const pid = Number((await readFile(config.pidPath, 'utf8').catch(() => '')).trim())

if (!Number.isInteger(pid) || pid <= 0) {
  logger.warn({ pidPath: config.pidPath }, 'no pid file; serve does not look like it is running')
  process.exit(0)
}

try {
  // SIGTERM, not SIGKILL: serve has to unload the models and close the SDK.
  process.kill(pid, 'SIGTERM')
  logger.info({ pid }, 'asked serve to stop')
} catch (error) {
  if (error.code !== 'ESRCH') throw error
  logger.warn({ pid }, 'serve was already gone')
}

await rm(config.pidPath, { force: true })
