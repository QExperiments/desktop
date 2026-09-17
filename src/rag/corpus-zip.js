import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

// `setup` in qvac-eval.json runs corpus:ingest straight after models:fetch,
// so the corpus has to come out of corpus.zip without a hand step. The zip is
// taken as given (no rewriting before indexing) and lands under data/, where
// its top-level `corpus/` directory is what ingest walks. Node has no zip
// reader of its own; `unzip` covers macOS and Linux, bsdtar covers Windows.
export const unpackCorpus = async ({ corpusDir, zipPath, dataDir }) => {
  if (existsSync(corpusDir)) return { unpacked: false, reason: 'already present' }
  if (!zipPath || !existsSync(zipPath)) return { unpacked: false, reason: 'no corpus.zip' }
  await mkdir(dataDir, { recursive: true })
  const attempts = [
    ['unzip', ['-o', '-q', zipPath, '-d', dataDir]],
    ['tar', ['-xf', zipPath, '-C', dataDir]],
  ]
  let lastError = null
  for (const [command, args] of attempts) {
    try {
      await run(command, args)
      if (existsSync(corpusDir)) return { unpacked: true, tool: command }
      lastError = new Error(`${command} finished but ${corpusDir} is still missing`)
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`could not unpack ${zipPath}: ${lastError?.message ?? 'unknown error'}`)
}
