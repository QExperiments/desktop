import fs from 'node:fs'
import path from 'node:path'
import { loadModel, unloadModel, embed, ragChunk, close } from '@qvac/sdk'
import {
  config,
  getEmbeddingModelSrc,
  docTextForEmbedding,
  addChunks,
  buildFtsIndex,
  clearCollection,
  count,
  chunkId,
  contentHash,
  embeddingRecipe,
  deleteByFile,
  listIndexedHashes,
} from './store.mjs'

// Walks the corpus directory recursively, collecting files while skipping system and macOS metadata entries.
export function walkCorpus(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.name === '__MACOSX' || entry.name.startsWith('.')) continue
    if (entry.isDirectory()) walkCorpus(full, base, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

// Converts an absolute path into a forward-slash relative path for stable identifiers.
function relFile(full, base) {
  return path.relative(base, full).split(path.sep).join('/')
}

// Derives the document type from the top-level folder under the corpus base.
function docType(file, base) {
  const rel = path.relative(base, file)
  const parts = rel.split(path.sep)
  return parts.length > 1 ? parts[0] : 'root'
}

// Strips HTML tags and entities, collapsing whitespace into readable plain text.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|td|th|ul|ol|blockquote|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Parses CSV text into rows, handling quoted fields and escaped quotes.
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// Turns CSV into key=value lines, using the header row as field names.
function csvToText(csv) {
  const rows = parseCsv(csv)
  if (rows.length === 0) return ''
  const header = rows[0]
  return rows
    .slice(1)
    .map((row) => header.map((h, i) => `${h}=${row[i] ?? ''}`).join(', '))
    .join('\n')
}

// Flattens JSON into dotted key=value lines, including array indices.
function jsonToText(value, prefix = '', out = []) {
  if (value === null || value === undefined) return out
  if (typeof value !== 'object') {
    out.push(`${prefix}=${value}`)
    return out
  }
  for (const [key, val] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${key}` : key
    if (Array.isArray(val)) {
      val.forEach((item, i) => jsonToText(item, `${p}[${i}]`, out))
    } else if (val !== null && typeof val === 'object') {
      jsonToText(val, p, out)
    } else {
      out.push(`${p}=${val}`)
    }
  }
  return out
}

// CSV_ROW_CHUNKS: one unit per CSV row (the key=value line of csvToText) and,
// for JSON, one unit per element of every top-level array plus one unit with
// the top-level scalars; each unit becomes its own chunk instead of the file
// being chunked by tokens. Returns null when the file has no row structure.
function rowUnits(ext, raw) {
  if (ext === '.csv') return csvToText(raw).split('\n').filter((line) => line.trim())
  if (ext === '.json') {
    const value = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const scalars = []
    const units = []
    for (const [key, val] of Object.entries(value)) {
      if (Array.isArray(val)) val.forEach((item, i) => units.push(jsonToText(item, `${key}[${i}]`).join(', ')))
      else if (val !== null && typeof val === 'object') units.push(jsonToText(val, key).join(', '))
      else scalars.push(`${key}=${val}`)
    }
    return [scalars.join('\n'), ...units].filter((u) => u.trim())
  }
  return null
}

// Reads a file and converts it to plain text based on its extension.
export function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const raw = fs.readFileSync(filePath, 'utf8')
  switch (ext) {
    case '.md':
    case '.txt':
      return raw
    case '.html':
      return htmlToText(raw)
    case '.csv':
      return csvToText(raw)
    case '.json':
      return jsonToText(JSON.parse(raw)).join('\n')
    default:
      return null
  }
}

// The units a file is chunked from when CSV_ROW_CHUNKS is on: rows / records
// for csv and json, null (chunk the whole text) for everything else.
export function parseUnits(filePath) {
  if (!config.rowChunks) return null
  const ext = path.extname(filePath).toLowerCase()
  if (ext !== '.csv' && ext !== '.json') return null
  return rowUnits(ext, fs.readFileSync(filePath, 'utf8'))
}

// CHUNK_HEADER: the first line of every chunk names the file, its folder and
// the file's subject (its first non-empty line, markdown marks and a
// `Subject:` label stripped), so a chunk from the middle of a document still
// says which document it is from, for both the vector and the BM25 leg.
export function chunkHeader(rel, type, text) {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l) || ''
  const subject = first.replace(/^#+\s*/, '').replace(/^subject:\s*/i, '').slice(0, 120)
  return `file: ${rel} · type: ${type} · ${subject}`
}

// Ingests the whole corpus: parses files, chunks and embeds them, skipping files that already match their stored hash.
// Returns the counts and the embedding statistics of the run. `closeSdk: false`
// keeps the SDK worker alive for a caller that goes on to search in-process.
export async function ingest({ force = false, closeSdk = true } = {}) {
  const startedAt = Date.now()
  // embed().stats.totalTokens is cumulative over the model's lifetime, so the
  // per-call count is the difference; times are wall clock (the SDK's totalTime is not reliable).
  const stats = { files: 0, chunks: 0, embedded: 0, skipped: 0, embed_tokens: 0, embed_ms: 0, embed_calls: 0, load_ms: null }
  let seenTokens = 0
  const modelSrc = getEmbeddingModelSrc()
  const recipe = embeddingRecipe(modelSrc.modelId)
  console.log(`Embedding model: ${modelSrc.local ? 'local file' : 'registry'} (${modelSrc.modelId})`)

  if (force) {
    console.log('--force: clearing existing collection')
    await clearCollection()
  }

  const files = walkCorpus(config.corpusDir)
  console.log(`Found ${files.length} corpus files`)

  const indexed = await listIndexedHashes()

  const loadStart = Date.now()
  const modelId = await loadModel({
    modelSrc: modelSrc.modelSrc,
    modelType: modelSrc.modelType,
    modelConfig: config.embeddingModelConfig,
    onProgress: (p) => {
      const mb = (n) => (n / 1e6).toFixed(1)
      process.stderr.write(`\rDownloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`)
      if (p.percentage >= 100) process.stderr.write('\n')
    },
  })
  stats.load_ms = Date.now() - loadStart

  try {
    let totalChunks = 0
    let embeddedChunks = 0
    let skipped = 0

    for (const file of files) {
      const rel = relFile(file, config.corpusDir)

      let text
      try {
        text = parseFile(file)
      } catch (err) {
        console.warn(`Skipping ${rel}: ${err.message}`)
        continue
      }
      if (text === null || text.trim() === '') {
        continue
      }

      const hash = contentHash(text, recipe)

      // Skip files whose content is unchanged; remove and re-add those that changed.
      if (!force && indexed[rel] === hash) {
        skipped++
        continue
      }
      if (!force && indexed[rel] !== undefined) {
        console.log(`Re-indexing changed file: ${rel}`)
        await deleteByFile(rel)
      }

      const units = parseUnits(file)
      const chunks = units
        ? units.map((content) => ({ content }))
        : await ragChunk({
          documents: [text],
          chunkOpts: config.chunkOpts,
        })

      const type = docType(file, config.corpusDir)
      const header = config.chunkHeader ? chunkHeader(rel, type, text) : null
      const ids = []
      const documents = []
      const metadatas = []
      for (let i = 0; i < chunks.length; i++) {
        ids.push(chunkId(rel, i))
        documents.push(header ? `${header}\n${chunks[i].content}` : chunks[i].content)
        metadatas.push({
          file: rel,
          type,
          title: path.basename(file),
          chunk_index: i,
          content_hash: hash,
          model_id: modelSrc.modelId,
        })
      }

      if (documents.length > 0) {
        const t0 = Date.now()
        const { embedding, stats: embedStats } = await embed({ modelId, text: documents.map((doc) => docTextForEmbedding(doc, path.basename(file))) })
        stats.embed_ms += Date.now() - t0
        stats.embed_calls += 1
        if (Number.isFinite(embedStats?.totalTokens)) {
          stats.embed_tokens += embedStats.totalTokens >= seenTokens ? embedStats.totalTokens - seenTokens : embedStats.totalTokens
          seenTokens = embedStats.totalTokens
        }
        await addChunks({ ids, embeddings: embedding, documents, metadatas })
        embeddedChunks += documents.length
      }
      totalChunks += chunks.length
    }

    console.log(`\nDone. ${embeddedChunks} chunks embedded, ${skipped} files already indexed.`)
    const ftsStart = Date.now()
    await buildFtsIndex()
    stats.fts_ms = Date.now() - ftsStart
    stats.files = files.length
    stats.chunks = totalChunks
    stats.embedded = embeddedChunks
    stats.skipped = skipped
    stats.in_store = await count()
    stats.ingest_ms = Date.now() - startedAt
    stats.embed_tps = stats.embed_ms ? Number((stats.embed_tokens / (stats.embed_ms / 1000)).toFixed(1)) : null
    console.log(`Total chunks now in store: ${stats.in_store}`)
  } finally {
    await unloadModel({ modelId })
    if (closeSdk) await close()
  }
  return stats
}