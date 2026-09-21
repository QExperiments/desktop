// One variant of the retrieval experiment (docs/todo-3-exp.md), run in its
// own process so the env-driven config of src/rag/store.mjs is read fresh:
// ingest the corpus into LANCE_DB_DIR (unless the table is already there and
// --reingest is not given), then run every retrieval case at every k of
// K_LIST and write turns-<variant>.jsonl and variant-<variant>.json into
// --out. No LLM is involved: embed() for the queries and LanceDB.
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { close, embed, loadModel, unloadModel } from '@qvac/sdk'
import { loadCases } from './cases.mjs'
import { K_LIST, aggregateRetrieval, percentile, scoreRetrieval } from './metrics/retrieval.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { values: flags } = parseArgs({ options: { variant: { type: 'string' }, out: { type: 'string' }, cases: { type: 'string' }, reingest: { type: 'boolean', default: false } } })
if (!flags.variant || !flags.out) { console.error('usage: node evals/lib/retrieval-exp-worker.mjs --variant <name> --out <dir> [--cases dir] [--reingest]'); process.exit(2) }

const { config, count, getEmbeddingModelSrc } = await import('../../src/rag/store.mjs')
const { ingest } = await import('../../src/rag/ingest.mjs')
const { search } = await import('../../src/rag/retrieve.mjs')
const { historyConfig, looksElliptical, queryTexts } = await import('../../src/rag/query-history.mjs')

const out = resolve(flags.out)
await mkdir(out, { recursive: true })
const log = (msg) => console.error(`[${flags.variant}] ${msg}`)

const dirBytes = async (dir) => {
  let total = 0
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) await walk(p)
      else total += (await stat(p)).size
    }
  }
  await walk(dir)
  return total
}

// ---- ingest
// ingest() always runs: it skips every file whose recipe hash (model, prefix,
// dims, chunking) matches the index, so a fresh or matching index costs one
// model load, and an index left by another configuration is rebuilt file by
// file instead of being searched with the wrong vectors.
const have = await count()
log(have ? `index present (${have} chunks), checking its recipe` : `ingest into ${config.vectorStoreDir}`)
const ingestStats = await ingest({ force: flags.reingest, closeSdk: false })
if (ingestStats.embedded) log(`re-indexed ${ingestStats.embedded} chunks (${ingestStats.skipped} files unchanged)`)
const chunks = await count()
const indexBytes = await dirBytes(config.vectorStoreDir)

// ---- queries: one embed per query (cached across the k values), one search per k
const plan = await loadCases({ dir: flags.cases ? resolve(flags.cases) : join(here, '..', 'cases'), only: ['retrieval'], runs: 1 })
const cases = plan.retrieval.map((job) => job.case)
const source = getEmbeddingModelSrc()
const t0 = Date.now()
const modelId = await loadModel({ modelSrc: source.modelSrc, modelType: source.modelType, modelConfig: config.embeddingModelConfig })
const loadMs = Date.now() - t0
log(`query model loaded in ${loadMs} ms (${source.modelId}, ${source.local ? 'local' : 'registry'})`)

// embedAccum: embed time since the caller reset it; a search may embed more
// than one text (QUERY_HISTORY_MODE=fuse), a cache hit costs nothing.
const cache = new Map()
let embedAccum = 0
let backendDevice = null
const embedWith = async (text) => {
  if (cache.has(text)) return cache.get(text)
  const start = Date.now()
  const result = await embed({ modelId, text })
  embedAccum += Date.now() - start
  backendDevice = result.stats?.backendDevice ?? backendDevice
  cache.set(text, result)
  return result
}

const deepest = Math.max(...K_LIST)
const rows = []
for (const item of cases) {
  const perK = {}
  const searchMs = {}
  let embedMs = 0
  let hits = []
  // The search text: the question alone, or joined with the case's earlier
  // questions (`history`) when QUERY_HISTORY_TURNS > 1.
  const texts = queryTexts(item.query, item.history ?? [], undefined, { followup: (item.tags ?? []).includes('kind:followup') })
  for (const k of K_LIST) {
    embedAccum = 0
    const start = Date.now()
    const results = await search(item.query, k, { embed: embedWith, vectorTexts: texts.vectorTexts, ftsTexts: texts.ftsTexts })
    const elapsed = Date.now() - start
    embedMs += embedAccum
    searchMs[k] = elapsed - embedAccum
    // The store returns the whole fused list (up to two legs); ranks and MRR
    // are read off the top-`deepest` chunks so every variant is judged at the same depth.
    perK[k] = results.slice(0, k === deepest ? deepest : results.length).map((r) => r.file)
    if (k === deepest) hits = results.slice(0, deepest).map((r) => ({ file: r.file, chunkIndex: r.chunkIndex, score: r.score }))
  }
  rows.push({
    category: 'retrieval', id: item.id, query: item.query, gold: item.gold_doc_ids, tags: item.tags ?? [],
    history: (item.history ?? []).length, search_query: texts.joined, elliptical: looksElliptical(item.query),
    embed_ms: embedMs, search_ms: searchMs[deepest], retrieval_ms: embedMs + searchMs[deepest], search_ms_by_k: searchMs,
    hits, ...scoreRetrieval(perK, item.gold_doc_ids),
  })
}
await unloadModel({ modelId })
await close()

const ms = (key) => rows.map((r) => r[key]).filter(Number.isFinite)
const summary = {
  variant: flags.variant,
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(EMBEDDING_MODEL|CHUNK_|EMBED_|CSV_ROW_CHUNKS|FTS_|RRF_|LANCE_DB_DIR|TOP_K|QUERY_HISTORY_)/.test(k))),
  model: { id: source.modelId, local: source.local, bytes: source.bytes, config: config.embeddingModelConfig, backend: backendDevice, load_ms: loadMs },
  index: { dir: config.vectorStoreDir, chunks, bytes: indexBytes, dims: config.embedDims || null, fts: (await import('../../src/rag/store.mjs')).ftsOptions(), rrf: config.rrf, chunkOpts: config.chunkOpts, chunkHeader: config.chunkHeader, rowChunks: config.rowChunks, embedPrefix: config.embedPrefix || null, history: historyConfig() },
  ingest: ingestStats,
  k_list: K_LIST,
  n: rows.length,
  aggregate: {
    ...aggregateRetrieval(rows),
    retrieval_ms_p95: percentile(ms('retrieval_ms'), 0.95),
    embed_ms_p50: percentile(ms('embed_ms'), 0.5),
    search_ms_p50: percentile(ms('search_ms'), 0.5),
    search_ms_p95: percentile(ms('search_ms'), 0.95),
  },
  finished_at: new Date().toISOString(),
}
await writeFile(join(out, `turns-${flags.variant}.jsonl`), rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
await writeFile(join(out, `variant-${flags.variant}.json`), `${JSON.stringify(summary, null, 2)}\n`)
const a = summary.aggregate
log(`done: n=${rows.length} chunks=${chunks} recall@1=${(a.at[1].recall * 100).toFixed(0)}% @3=${(a.at[3].recall * 100).toFixed(0)}% @5=${(a.at[5].recall * 100).toFixed(0)}% @10=${(a.at[10].recall * 100).toFixed(0)}% MRR=${a.mrr.toFixed(3)} retrieval_ms p50=${a.retrieval_ms_p50}`)
