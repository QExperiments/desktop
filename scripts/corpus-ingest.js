import { existsSync } from 'node:fs'
import { ingest } from '../src/rag/ingest.mjs'
import { config } from '../src/rag/store.mjs'

// qvac-eval.json runs this in `setup`. The corpus is expected unpacked at
// data/corpus, so `unzip corpus.zip -d data/` is the one step before it.
if (!existsSync(config.corpusDir)) {
  console.error(`corpus:ingest: ${config.corpusDir} not found — run: unzip corpus.zip -d data/`)
  process.exit(1)
}

await ingest({ force: process.argv.includes('--force') })
