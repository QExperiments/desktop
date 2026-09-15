import { readFile, rm } from 'node:fs/promises'
import { config } from './config.js'
import { logger } from './logger.js'

const pidPath = config.pidPath

try {
  const pid = Number((await readFile(pidPath, 'utf8')).trim())

  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('invalid pid file')
  }

  process.kill(pid, 'SIGTERM')
  await rm(pidPath, { force: true })

  logger.info({ pid }, 'stopped serve')
} catch (error) {
  if (error.code === 'ENOENT') {
    logger.error('no pid file; is serve running?')
    process.exit(1)
  }

  logger.error(error.message)
  process.exit(1)
}
