// CLI entry for retrieval metrics. Loads the embedding model, runs the fixed
// eval query set against the vector store and prints recall@k and precision@k
// plus the per-query ranks. Prerequisites: `npm run models:fetch` and
// `npm run corpus:ingest` (with `-- --force` after a chunk-config change).
import { parseArgs } from 'node:util'
import { close } from '@qvac/sdk'
import { evalRecall, releaseModel } from '../src/rag/retrieve.mjs'

const { values } = parseArgs({
  options: {
    k: { type: 'string' },
  },
})

const kList = values.k ? values.k.split(',').map((n) => Number(n.trim())) : [3, 5, 10]

try {
  await evalRecall(kList)
} finally {
  await releaseModel()
  await close()
}
