// Core of the RAG store: configuration, LanceDB table handling and hybrid search.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import * as lancedb from '@lancedb/lancedb'
import { EMBEDDINGGEMMA_300M_Q8_0 } from '@qvac/sdk'

// The project root is derived from this file, so paths under data stay correct regardless of where the process is started.
const appRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))

// Central config: paths to the corpus, models and vector store, plus chunking and search settings.
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
  },
}

// Returns the embedding model source. The model manager writes a manifest of
// { version, tier, entries } where the embed entry lives under `embed:<tier>`
// and carries the resolved path; when it is absent or missing on disk, fall
// back to the registry model.
export function getEmbeddingModelSrc() {
  try {
    const manifest = JSON.parse(fs.readFileSync(config.manifestFile, 'utf8'))
    const tier = manifest.tier
    const entry = (tier && manifest.entries?.[`embed:${tier}`]) || Object.values(manifest.entries || {}).find((e) => e.role === 'embed')
    if (entry?.path && fs.existsSync(entry.path)) {
      return { modelSrc: entry.path, modelType: entry.modelType || 'llamacpp-embedding', modelId: entry.constant || config.embeddingModelId, local: true }
    }
  } catch {
  }
  return { modelSrc: EMBEDDINGGEMMA_300M_Q8_0, modelType: undefined, modelId: config.embeddingModelId, local: false }
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
      return { id, vector: embeddings[idx], text: documents[idx], ...metadatas[idx] }
    })
    if (!table) {
      table = await db.createTable(config.tableName, rows)
    } else {
      await table.add(rows)
    }
  }
}

// Hybrid search: runs a vector (cosine) and a full-text query, then fuses the rankings.
export async function query(queryText, queryEmbedding, topK = config.topK) {
  const table = await openTable()
  if (!table) return []

  const lists = []

  try {
    const vec = await table.search(queryEmbedding).distanceType('cosine').limit(topK).toArray()
    lists.push(vec)
  } catch {
  }

  try {
    const fts = await table.query().fullTextSearch(queryText, { columns: ['text'] }).limit(topK).toArray()
    lists.push(fts)
  } catch {
  }

  if (lists.length === 0) return []

  const fused = rrfFuse(lists)
  return fused.map((r) => ({
    content: r.text,
    file: r.file || null,
    type: r.type || null,
    title: r.title || null,
    chunkIndex: r.chunk_index ?? null,
    score: Number(r.rrf.toFixed(4)),
    metadata: {
      rrfScore: Number(r.rrf.toFixed(4)),
      cosineScore: r._distance === null || r._distance === undefined ? null : Number((1 - r._distance).toFixed(4)),
      bm25Score: r._score === null || r._score === undefined ? null : Number(r._score.toFixed(4)),
    },
  }))
}

// Reciprocal Rank Fusion: merges the ranked lists, weighting each result by its position.
function rrfFuse(lists, k = 60) {
  const rows = {}
  for (const list of lists) {
    list.forEach((item, rank) => {
      const id = item.id
      if (!rows[id]) rows[id] = { ...item, rrf: 0, _distance: null, _score: null }
      rows[id].rrf += 1 / (k + rank + 1)
      if (item._distance !== undefined) rows[id]._distance = item._distance
      if (item._score !== undefined) rows[id]._score = item._score
    })
  }
  return Object.values(rows).sort((a, b) => b.rrf - a.rrf)
}

// Creates a full-text search index over the text column if one is not already present.
async function ensureFtsIndex(table) {
  const indices = await table.listIndices()
  const hasFts = indices.some((i) => i.indexType === 'fts' && (i.columns || []).includes('text'))
  if (!hasFts) {
    await table.createIndex('text', {
      config: lancedb.Index.fts({ lowercase: true }),
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

// Computes a sha256 hash used to detect content changes between runs.
export function contentHash(text) {
  return createHash('sha256').update(text).digest('hex')
}