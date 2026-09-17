import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { unpackCorpus } from '../src/rag/corpus-zip.js'
import { ingest } from '../src/rag/ingest.mjs'
import { config } from '../src/rag/store.mjs'

// qvac-eval.json runs this in `setup`. The corpus is expected unpacked at
// data/corpus; when it is not there yet, corpus.zip from the repo root (or
// MERIDIAN_CORPUS_ZIP) is unpacked into data/ first.
const zipPath = process.env.MERIDIAN_CORPUS_ZIP || join(config.appRoot, 'corpus.zip')
const unpacked = await unpackCorpus({ corpusDir: config.corpusDir, zipPath, dataDir: join(config.appRoot, 'data') })
if (unpacked.unpacked) console.log(`corpus:ingest: unpacked ${zipPath} with ${unpacked.tool}`)

if (!existsSync(config.corpusDir)) {
  console.error(`corpus:ingest: ${config.corpusDir} not found and no ${zipPath} — run: unzip corpus.zip -d data/`)
  process.exit(1)
}

await ingest({ force: process.argv.includes('--force') })
