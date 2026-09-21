// Core of the RAG store: configuration, LanceDB table handling and hybrid search.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import * as lancedb from '@lancedb/lancedb'
import * as sdk from '@qvac/sdk'

// The project root is derived from this file, so paths under data stay correct regardless of where the process is started.
const appRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))

const flag = (name, fallback) => (process.env[name] === undefined || process.env[name] === '' ? fallback : !['0', 'false', 'off', 'no'].includes(process.env[name].toLowerCase()))

// Central config: paths to the corpus, models and vector store, plus chunking and search settings.
// Every knob below has the production default; the env overrides exist for the
// retrieval experiment (docs/todo-3-exp.md) and leave the defaults untouched.
export const config = {
  appRoot,
  corpusDir: path.join(appRoot, 'data', 'corpus'),
  modelsDir: path.join(appRoot, 'data', 'models'),
  manifestFile: path.join(appRoot, 'data', 'models', 'manifest.json'),
  vectorStoreDir: process.env.LANCE_DB_DIR || path.join(appRoot, 'data', 'lancedb'),
  tableName: process.env.LANCE_TABLE || 'meridian_corpus',
  embeddingModelId: process.env.EMBEDDING_MODEL || 'EMBEDDINGGEMMA_300M_Q8_0',
  chunkOpts: {
    chunkSize: Number(process.env.CHUNK_SIZE || 512),
    chunkOverlap: Number(process.env.CHUNK_OVERLAP || 64),
    chunkStrategy: process.env.CHUNK_STRATEGY || 'paragraph',
    // 'sentence' never splits in SDK 0.18.2: a 4 400-char report came back as one chunk.
    splitStrategy: process.env.CHUNK_SPLIT || 'token',
  },
  topK: Number(process.env.TOP_K || 5),
  addBatchSize: Number(process.env.ADD_BATCH_SIZE || 128),
  embeddingModelConfig: {
    batchSize: Number(process.env.EMBED_BATCH || 4096),
    // EMBED_DEVICE=cpu approximates the fleet laptop (iGPU) on the dev Mac.
    ...(process.env.EMBED_DEVICE === 'cpu' ? { device: 'cpu', gpuLayers: 0 } : {}),
  },
  // Matryoshka truncation of the stored and the query vector (0 = full width).
  embedDims: Number(process.env.EMBED_DIMS || 0),
  // 'gemma' (default since ADR-013): EmbeddingGemma task prefixes on documents
  // and queries; EMBED_PREFIX='' or 'none' embeds the raw text.
  embedPrefix: process.env.EMBED_PREFIX === undefined ? 'gemma' : (process.env.EMBED_PREFIX === 'none' ? '' : process.env.EMBED_PREFIX),
  // Chunk text preparation at ingest (see ingest.mjs): a file header line in
  // every chunk; CSV rows and JSON records as their own chunks.
  chunkHeader: flag('CHUNK_HEADER', false),
  rowChunks: flag('CSV_ROW_CHUNKS', false),
  // Full-text index options; the LanceDB defaults are the production ones.
  fts: {
    baseTokenizer: process.env.FTS_TOKENIZER || 'simple',
    stem: flag('FTS_STEM', true),
    removeStopWords: flag('FTS_STOPWORDS', true),
    ngram: Number(process.env.FTS_NGRAM || 3),
  },
  // RRF: the constant, the depth of each leg (0 = topK, as shipped) and the
  // weight of the BM25 leg relative to the vector leg (1.5 since ADR-013).
  rrf: {
    k: Number(process.env.RRF_K || 60),
    candidates: Number(process.env.RRF_CANDIDATES || 0),
    bm25Weight: Number(process.env.RRF_BM25_WEIGHT || 1.5),
  },
}

// Returns the embedding model source. The model manager writes a manifest of
// { version, tier, entries } where the embed entry lives under `embed:<tier>`
// and carries the resolved path; when it is absent or missing on disk, fall
// back to the registry model. EMBEDDING_MODEL naming a different SDK constant
// than the manifest's wins over the manifest (experiment path).
export function getEmbeddingModelSrc() {
  const wanted = config.embeddingModelId
  try {
    const manifest = JSON.parse(fs.readFileSync(config.manifestFile, 'utf8'))
    const tier = manifest.tier
    const entry = (tier && manifest.entries?.[`embed:${tier}`]) || Object.values(manifest.entries || {}).find((e) => e.role === 'embed')
    const matches = !process.env.EMBEDDING_MODEL || !entry?.constant || entry.constant === wanted
    if (matches && entry?.path && fs.existsSync(entry.path)) {
      return { modelSrc: entry.path, modelType: entry.modelType || 'llamacpp-embedding', modelId: entry.constant || wanted, local: true, bytes: fs.statSync(entry.path).size }
    }
  } catch {
  }
  const constant = sdk[wanted]
  if (!constant) throw new Error(`EMBEDDING_MODEL=${wanted} is not an @qvac/sdk model constant`)
  return { modelSrc: constant, modelType: undefined, modelId: wanted, local: false, bytes: constant.expectedSize ?? null }
}

// EmbeddingGemma was trained with task prefixes; without EMBED_PREFIX both
// helpers return the text unchanged. The stored `text` column never carries
// the prefix, so BM25 sees the raw chunk.
export function docTextForEmbedding(text, title = 'none') {
  return config.embedPrefix === 'gemma' ? `title: ${title || 'none'} | text: ${text}` : text
}
export function queryTextForEmbedding(text) {
  return config.embedPrefix === 'gemma' ? `task: search result | query: ${text}` : text
}

// Matryoshka truncation: keep the first EMBED_DIMS coordinates and renormalise.
export function fitVector(vector) {
  if (!config.embedDims || !Array.isArray(vector) || vector.length <= config.embedDims) return vector
  const cut = vector.slice(0, config.embedDims)
  const norm = Math.sqrt(cut.reduce((s, v) => s + v * v, 0)) || 1
  return cut.map((v) => v / norm)
}

let db

// Opens a connection to the vector store and keeps it in memory for the lifetime of the process.
export async function getDb() {
  if (!db) db = await lancedb.connect(config.vectorStoreDir)
  return db
}

// Opens the corpus table, or returns null when it has not been created yet.
export async function openTable() {
  const db = await getDb()
  try {
    return await db.openTable(config.tableName)
  } catch {
    return null
  }
}

// Drops the whole corpus table so the store can be rebuilt from scratch.
export async function clearCollection() {
  const db = await getDb()
  try {
    await db.dropTable(config.tableName)
  } catch {
  }
}

// Adds rows in batches, creating the table on the first batch if it does not exist yet.
export async function addChunks({ ids, embeddings, documents, metadatas }) {
  const db = await getDb()
  let table = await openTable()
  for (let i = 0; i < ids.length; i += config.addBatchSize) {
    const slice = (arr) => arr.slice(i, i + config.addBatchSize)
    const rows = slice(ids).map((id, j) => {
      const idx = i + j
      return { id, vector: fitVector(embeddings[idx]), text: documents[idx], ...metadatas[idx] }
    })
    if (!table) {
      table = await db.createTable(config.tableName, rows)
    } else {
      await table.add(rows)
    }
  }
}

// Search over the corpus table. `fusion` (ADR-012) picks the ranking:
// `rrf` runs a vector (cosine) and a full-text (BM25) query and fuses the two
// rankings; `cosine` and `bm25` return one of them alone. `score` is the RRF
// score, the cosine similarity or the BM25 score respectively, so it is
// comparable within one fusion mode only. Each leg fetches
// max(topK, RRF_CANDIDATES) rows; the fused list is returned whole (up to two
// legs' worth) and callers take the head they need. `queryText` and
// `queryEmbedding` may each be an array: one list per text / vector.
export const FUSIONS = ['rrf', 'cosine', 'bm25']
export async function query(queryText, queryEmbedding, topK = config.topK, { fusion = 'rrf' } = {}) {
  if (!FUSIONS.includes(fusion)) throw new Error(`fusion must be one of ${FUSIONS.join(', ')}, not ${fusion}`)
  const table = await openTable()
  if (!table) return []

  const lists = []
  const weights = []
  const depth = Math.max(topK, config.rrf.candidates || 0)

  // A leg may search for several texts (src/rag/query-history.mjs, mode
  // `fuse`: the question alone and the question with its history): one ranked
  // list per text, all fused, so a chunk found for both counts twice.
  const vectors = queryEmbedding == null ? [] : (typeof queryEmbedding[0] === 'number' ? [queryEmbedding] : Array.from(queryEmbedding))
  const texts = Array.isArray(queryText) ? queryText : [queryText]

  if (fusion !== 'bm25') {
    for (const vector of vectors) {
      try {
        const vec = await table.search(fitVector(vector)).distanceType('cosine').limit(depth).toArray()
        lists.push(vec)
        weights.push(1)
      } catch {
      }
    }
  }

  if (fusion !== 'cosine') {
    for (const text of texts) {
      try {
        const fts = await table.query().fullTextSearch(text, { columns: ['text'] }).limit(depth).toArray()
        lists.push(fts)
        weights.push(config.rrf.bm25Weight)
      } catch {
      }
    }
  }

  if (lists.length === 0) return []

  const fused = rrfFuse(lists, config.rrf.k, weights)
  const scoreOf = (r) => fusion === 'cosine' ? (r._distance === null ? null : 1 - r._distance) : fusion === 'bm25' ? r._score : r.rrf
  return fused.map((r) => ({
    content: r.text,
    file: r.file || null,
    type: r.type || null,
    title: r.title || null,
    chunkIndex: r.chunk_index ?? null,
    score: scoreOf(r) === null || scoreOf(r) === undefined ? undefined : Number(scoreOf(r).toFixed(4)),
    metadata: {
      fusion,
      rrfScore: Number(r.rrf.toFixed(4)),
      cosineScore: r._distance === null || r._distance === undefined ? null : Number((1 - r._distance).toFixed(4)),
      bm25Score: r._score === null || r._score === undefined ? null : Number(r._score.toFixed(4)),
    },
  }))
}

// Reciprocal Rank Fusion: merges the ranked lists, weighting each result by its
// position; `weights[i]` scales the contribution of list i (1 = plain RRF).
function rrfFuse(lists, k = 60, weights = []) {
  const rows = {}
  lists.forEach((list, li) => {
    const w = weights[li] ?? 1
    list.forEach((item, rank) => {
      const id = item.id
      if (!rows[id]) rows[id] = { ...item, rrf: 0, _distance: null, _score: null }
      rows[id].rrf += w / (k + rank + 1)
      if (item._distance !== undefined) rows[id]._distance = item._distance
      if (item._score !== undefined) rows[id]._score = item._score
    })
  })
  return Object.values(rows).sort((a, b) => b.rrf - a.rrf)
}

// The FTS index options: LanceDB defaults (simple tokenizer, English stemming
// and stop words, ascii folding) plus lowercase, unless the env says otherwise.
// The ngram tokenizer indexes character n-grams, so stemming and stop words are off with it.
export function ftsOptions() {
  const { baseTokenizer, stem, removeStopWords, ngram } = config.fts
  if (baseTokenizer === 'ngram') return { lowercase: true, baseTokenizer, stem: false, removeStopWords: false, ngramMinLength: ngram, ngramMaxLength: ngram, prefixOnly: false }
  return { lowercase: true, baseTokenizer, stem, removeStopWords }
}

// Creates a full-text search index over the text column if one is not already present.
async function ensureFtsIndex(table) {
  const indices = await table.listIndices()
  const hasFts = indices.some((i) => i.indexType === 'fts' && (i.columns || []).includes('text'))
  if (!hasFts) {
    await table.createIndex('text', {
      config: lancedb.Index.fts(ftsOptions()),
      waitTimeoutSeconds: 60,
    })
  }
}

// Builds the full-text index for the open corpus table, if it exists.
export async function buildFtsIndex() {
  const table = await openTable()
  if (!table) return
  await ensureFtsIndex(table)
}

// Returns the number of rows in the corpus table, or zero when it is missing.
export async function count() {
  const table = await openTable()
  if (!table) return 0
  return table.countRows()
}

// Maps each indexed file to its content hash, so ingest can skip unchanged files.
export async function listIndexedHashes() {
  const table = await openTable()
  if (!table) return {}
  const rows = await table.query().select(['file', 'content_hash']).toArray()
  const byFile = {}
  for (const r of rows) if (r.file) byFile[r.file] = r.content_hash
  return byFile
}

// Removes every chunk belonging to the given file path.
export async function deleteByFile(file) {
  const table = await openTable()
  if (!table) return
  await table.delete(`file = '${file.replace(/'/g, "''")}'`)
}

// Builds a stable identifier for a single chunk of a file.
export function chunkId(file, chunkIndex) {
  return `${file}::${chunkIndex}`
}

// Computes a sha256 hash used to detect content changes between runs. The
// hash covers the embedding recipe as well as the text, so a change of model,
// prefix, dims or chunking re-indexes every file on the next ingest instead
// of leaving stale vectors next to a query embedded the new way.
export function embeddingRecipe(modelId) {
  return JSON.stringify({ model: modelId, prefix: config.embedPrefix, dims: config.embedDims, chunk: config.chunkOpts, header: config.chunkHeader, rows: config.rowChunks })
}
export function contentHash(text, recipe = '') {
  return createHash('sha256').update(recipe).update('\n').update(text).digest('hex')
}
