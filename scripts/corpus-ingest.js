// Real corpus ingest (Stage 2). Runs the RAG pipeline from src/rag/ingest.mjs:
// parses the corpus, chunks it, embeds and stores it in LanceDB, then builds
// the full-text index. Use `-- --force` to drop and rebuild the whole
// collection (required after changing chunk config).
//
// Prerequisites: `npm run models:fetch` so the embedding model is provisioned.
import { parseArgs } from 'node:util'
import { ingest } from '../src/rag/ingest.mjs'

const { values } = parseArgs({
  options: {
    force: { type: 'boolean', default: false },
  },
})

try {
  await ingest({ force: values.force })
} catch (error) {
  console.error(`corpus:ingest failed: ${error.message}`)
  process.exitCode = 1
}
