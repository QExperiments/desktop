import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// A run name is a directory name; keep it to the same alphabet as session ids.
const VALID = /^[\w.-]{1,64}$/

// Traces exist for the eval harness only. A request that carries an
// `x-eval-run: <run>` header gets its retrieval hits, tool rounds and stats
// written to data/traces/<run>/<requestId>.json; every other request writes
// nothing. The harness joins its own client-side record to the trace by the
// request id it reads from the response.
export const createTraces = (dir) => {
  const write = async (run, id, payload) => {
    if (!VALID.test(String(run)) || !VALID.test(String(id))) return null
    const target = join(dir, run)
    await mkdir(target, { recursive: true })
    const path = join(target, `${id}.json`)
    await writeFile(path, JSON.stringify(payload))
    return path
  }

  return { write }
}
