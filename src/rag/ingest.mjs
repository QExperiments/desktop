import fs from 'node:fs'
import path from 'node:path'
import { loadModel, unloadModel, embed, ragChunk, close } from '@qvac/sdk'
import {
  config,
  getEmbeddingModelSrc,
  addChunks,
  buildFtsIndex,
  clearCollection,
  count,
  chunkId,
  contentHash,
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

// Ingests the whole corpus: parses files, chunks and embeds them, skipping files that already match their stored hash.
export async function ingest({ force = false } = {}) {
  const modelSrc = getEmbeddingModelSrc()
  console.log(`Embedding model: ${modelSrc.local ? 'local file' : 'registry'} (${modelSrc.modelId})`)

  if (force) {
    console.log('--force: clearing existing collection')
    await clearCollection()
  }

  const files = walkCorpus(config.corpusDir)
  console.log(`Found ${files.length} corpus files`)

  const indexed = await listIndexedHashes()

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

      const hash = contentHash(text)

      // Skip files whose content is unchanged; remove and re-add those that changed.
      if (!force && indexed[rel] === hash) {
        skipped++
        continue
      }
      if (!force && indexed[rel] !== undefined) {
        console.log(`Re-indexing changed file: ${rel}`)
        await deleteByFile(rel)
      }

      const chunks = await ragChunk({
        documents: [text],
        chunkOpts: config.chunkOpts,
      })

      const ids = []
      const documents = []
      const metadatas = []
      for (let i = 0; i < chunks.length; i++) {
        ids.push(chunkId(rel, i))
        documents.push(chunks[i].content)
        metadatas.push({
          file: rel,
          type: docType(file, config.corpusDir),
          title: path.basename(file),
          chunk_index: i,
          content_hash: hash,
          model_id: modelSrc.modelId,
        })
      }

      if (documents.length > 0) {
        const { embedding } = await embed({ modelId, text: documents })
        await addChunks({ ids, embeddings: embedding, documents, metadatas })
        embeddedChunks += documents.length
      }
      totalChunks += chunks.length
    }

    console.log(`\nDone. ${embeddedChunks} chunks embedded, ${skipped} files already indexed.`)
    await buildFtsIndex()
    console.log(`Total chunks now in store: ${await count()}`)
  } finally {
    await unloadModel({ modelId })
    await close()
  }
}