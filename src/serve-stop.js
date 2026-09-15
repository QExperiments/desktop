import { readFile, rm } from 'node:fs/promises'
import { config } from './config.js'

const pidPath = config.pidPath

try {
  const pid = Number((await readFile(pidPath, 'utf8')).trim())

  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('invalid pid file')
  }

  process.kill(pid, 'SIGTERM')
  await rm(pidPath, { force: true })
  console.log(`stopped serve pid ${pid}`)
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('no pid file; is serve running?')
    process.exit(1)
  }
  console.error(error.message)
  process.exit(1)
}
