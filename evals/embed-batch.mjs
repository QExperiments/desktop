#!/usr/bin/env node
// `node evals/embed-batch.mjs`: batch versus sequential embedding (the [I.2] /
// [I.2.1] question of the brief, asked of the embed path; docs/todo-3-exp.md).
// Texts: the chunks of the production index (data/lancedb) and the retrieval
// cases. Three modes per model config — sequential awaits, one array call,
// N concurrent single calls — each repeated and reported as the median; plus
// an order check of the array result against the sequential vectors and a
// cancel of one in-flight request by requestId. Nothing leaves the machine.
//
//   --batch 512,1024,4096   modelConfig.batchSize values (default 512,1024,4096)
//   --cpu                   add a device: 'cpu' config (batchSize 4096)
//   --repeats 3             repeats per mode
//   --out <dir>             default evals/results/embed-batch-<ts>
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { cancel, close, embed, loadModel, unloadModel } from '@qvac/sdk'
import { loadCases } from './lib/cases.mjs'
import { config, getEmbeddingModelSrc, openTable } from '../src/rag/store.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { values: flags } = parseArgs({ options: { batch: { type: 'string', default: '512,1024,4096' }, cpu: { type: 'boolean', default: false }, repeats: { type: 'string', default: '3' }, out: { type: 'string' } } })
const repeats = Number(flags.repeats)
const out = resolve(flags.out ?? join(here, 'results', `embed-batch-${new Date().toISOString().replace(/[:.]/g, '-')}`))
await mkdir(out, { recursive: true })

const table = await openTable()
if (!table) { console.error(`no table at ${config.vectorStoreDir}; run corpus:ingest first`); process.exit(2) }
const chunks = (await table.query().select(['text']).toArray()).map((r) => r.text)
const queries = (await loadCases({ dir: join(here, 'cases'), only: ['retrieval'], runs: 1 })).retrieval.map((j) => j.case.query)
const sets = { chunks, queries }
console.log(`texts: ${chunks.length} chunks (${Math.round(chunks.reduce((s, t) => s + t.length, 0) / chunks.length)} chars mean), ${queries.length} queries`)

const median = (values) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const now = () => performance.now()
const source = getEmbeddingModelSrc()
const configs = [...flags.batch.split(',').map((b) => ({ label: `gpu · batchSize ${b}`, modelConfig: { batchSize: Number(b) } })), ...(flags.cpu ? [{ label: 'cpu · batchSize 4096', modelConfig: { batchSize: 4096, device: 'cpu', gpuLayers: 0 } }] : [])]

// tokens per call from the cumulative counter of the model
const tokenCounter = () => { let seen = 0; return (stats) => { if (!Number.isFinite(stats?.totalTokens)) return null; const d = stats.totalTokens >= seen ? stats.totalTokens - seen : stats.totalTokens; seen = stats.totalTokens; return d } }

const results = []
for (const cfg of configs) {
  console.log(`\n=== ${cfg.label}`)
  const t0 = now()
  const modelId = await loadModel({ modelSrc: source.modelSrc, modelType: source.modelType, modelConfig: cfg.modelConfig })
  const loadMs = now() - t0
  const tokens = tokenCounter()
  const warm = await embed({ modelId, text: ['warm-up text for the embedding model', 'second warm-up text'] })
  tokens(warm.stats)
  const backend = warm.stats?.backendDevice ?? null
  const row = { config: cfg.label, modelConfig: cfg.modelConfig, backend, contextSize: warm.stats?.contextSize ?? null, load_ms: Math.round(loadMs), sets: {} }
  try {

  for (const [setName, texts] of Object.entries(sets)) {
    const modes = {}
    let sequentialVectors = null
    // sequential
    {
      const runs = []
      for (let r = 0; r < repeats; r++) {
        const vectors = []
        let toks = 0
        let first = null
        const start = now()
        for (const text of texts) {
          const res = await embed({ modelId, text })
          if (first === null) first = now() - start
          toks += tokens(res.stats) ?? 0
          vectors.push(res.embedding)
        }
        runs.push({ wall: now() - start, first, toks })
        sequentialVectors = vectors
      }
      modes.sequential = summarise(runs, texts.length)
    }
    // one array call
    let arrayVectors = null
    {
      const runs = []
      for (let r = 0; r < repeats; r++) {
        const start = now()
        const res = await embed({ modelId, text: texts })
        const wall = now() - start
        runs.push({ wall, first: wall, toks: tokens(res.stats) ?? 0 })
        arrayVectors = res.embedding
      }
      modes.array = summarise(runs, texts.length)
    }
    // N concurrent single calls. The engine may refuse overlapping jobs
    // ("a job is already set"); rejected calls are counted, not fatal.
    {
      const runs = []
      let rejected = 0
      let firstError = null
      for (let r = 0; r < repeats; r++) {
        let first = null
        const start = now()
        const settled = await Promise.allSettled(texts.map((text) => embed({ modelId, text }).then((res) => { if (first === null) first = now() - start; return res })))
        const wall = now() - start
        const ok = settled.filter((x) => x.status === 'fulfilled').map((x) => x.value)
        rejected += settled.length - ok.length
        firstError ??= settled.find((x) => x.status === 'rejected')?.reason
        const toks = ok.reduce((s, res) => s + (tokens(res.stats) ?? 0), 0)
        runs.push({ wall, first, toks })
      }
      modes.concurrent = { ...summarise(runs, texts.length), rejected, of: texts.length * repeats, error: firstError ? String(firstError?.remoteStack ?? firstError?.message ?? firstError).split('\n')[0].slice(0, 160) : null }
    }
    // order check: array result i must be the vector of text i
    const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] } return d / Math.sqrt(na * nb) }
    const sims = arrayVectors.map((v, i) => cos(v, sequentialVectors[i]))
    const shuffled = arrayVectors.map((v, i) => cos(v, sequentialVectors[(i + 1) % sequentialVectors.length]))
    modes.order = { min_cosine_same_index: Math.min(...sims), max_cosine_neighbour: Math.max(...shuffled), ok: Math.min(...sims) > 0.999 }
    row.sets[setName] = { n: texts.length, ...modes, speedup: { array: modes.sequential.wall_ms / modes.array.wall_ms, concurrent: modes.sequential.wall_ms / modes.concurrent.wall_ms } }
    console.log(`${setName.padEnd(8)} n=${texts.length}  sequential ${modes.sequential.wall_ms.toFixed(0)} ms · array ${modes.array.wall_ms.toFixed(0)} ms (×${(modes.sequential.wall_ms / modes.array.wall_ms).toFixed(1)}) · concurrent ${modes.concurrent.wall_ms.toFixed(0)} ms (×${(modes.sequential.wall_ms / modes.concurrent.wall_ms).toFixed(1)}, ${modes.concurrent.rejected}/${modes.concurrent.of} rejected) · order ${modes.order.ok ? 'ok' : 'MISMATCH'}`)
  }

  // cancel: one of five concurrent single embeds is cancelled by requestId; the other four must complete.
  {
    const texts = chunks.slice(0, 5)
    const runs = texts.map((text) => embed({ modelId, text }))
    // settle handlers attached at once: a rejection while the cancel is awaited must not be unhandled
    const settling = runs.map((p) => p.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason })))
    const victim = runs[2]
    const start = now()
    let cancelError = null
    try { await cancel({ requestId: victim.requestId }) } catch (error) { cancelError = error.message }
    const outcomes = await Promise.all(settling)
    const victimOutcome = outcomes[2]
    const others = outcomes.filter((_, i) => i !== 2)
    row.cancel = {
      requestId: victim.requestId,
      cancel_call_error: cancelError,
      victim: victimOutcome.status === 'rejected' ? `rejected: ${victimOutcome.reason?.name ?? ''} ${String(victimOutcome.reason?.message ?? '').slice(0, 80)}` : 'fulfilled (finished before the cancel landed)',
      others_fulfilled: others.filter((o) => o.status === 'fulfilled').length,
      others_total: others.length,
      ms: Math.round(now() - start),
    }
    // and a long array request cancelled mid-flight, then the model still answers
    const big = embed({ modelId, text: [...chunks, ...chunks, ...chunks] })
    const startBig = now()
    setTimeout(() => cancel({ requestId: big.requestId }).catch(() => {}), 5)
    const bigOutcome = await big.then(() => 'fulfilled before the cancel landed', (error) => `rejected: ${error?.name ?? ''} ${String(error?.message ?? '').slice(0, 80)}`)
    const after = await embed({ modelId, text: 'still alive?' }).then(() => 'ok', (error) => `failed: ${error.message}`)
    row.cancel.array_request = { outcome: bigOutcome, ms: Math.round(now() - startBig), model_after_cancel: after }
    console.log(`cancel: victim ${row.cancel.victim}; others ${row.cancel.others_fulfilled}/${row.cancel.others_total}; array ${bigOutcome}; model after cancel: ${after}`)
  }
  } catch (error) {
    // A config that cannot embed the texts (batchSize below the longest chunk)
    // is a result too. The failed job leaves the engine refusing new jobs
    // ("a job is already set"), so the SDK worker is closed and respawned
    // by the next loadModel.
    row.error = String(error?.remoteStack ?? error?.message ?? error).split('\n')[0].slice(0, 200)
    console.log(`error: ${row.error}`)
    await unloadModel({ modelId }).catch(() => {})
    await close().catch(() => {})
    results.push(row)
    continue
  }

  await unloadModel({ modelId }).catch(() => {})
  results.push(row)
}
await close()

function summarise(runs, n) {
  const wall = median(runs.map((r) => r.wall))
  const toks = median(runs.map((r) => r.toks))
  return { wall_ms: wall, first_ms: median(runs.map((r) => r.first ?? r.wall)), texts_per_s: n / (wall / 1000), tokens: toks, tokens_per_s: toks ? toks / (wall / 1000) : null, repeats: runs.length }
}

// ---- report
const f0 = (v) => (Number.isFinite(v) ? v.toFixed(0) : 'n/a')
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a')
const headers = ['config', 'set', 'n', 'mode', 'wall ms', 'first result ms', 'texts/s', 'tok/s', 'speed-up vs sequential', 'rejected']
const rows = []
for (const r of results.filter((x) => !x.error)) for (const [setName, s] of Object.entries(r.sets)) for (const mode of ['sequential', 'array', 'concurrent']) {
  const m = s[mode]
  rows.push([r.config, setName, String(s.n), mode, f0(m.wall_ms), f0(m.first_ms), f1(m.texts_per_s), f0(m.tokens_per_s), mode === 'sequential' ? '1.0×' : m.rejected ? 'n/a' : `${f1(s.speedup[mode])}×`, mode === 'concurrent' ? `${m.rejected}/${m.of}${m.error ? ` — ${m.error}` : ''}` : '0'])
}
const mdTable = (h, rs) => [`| ${h.join(' | ')} |`, `| ${h.map(() => '---').join(' | ')} |`, ...rs.map((row) => `| ${row.join(' | ')} |`)].join('\n')
const errorRows = results.filter((r) => r.error).map((r) => [r.config, r.error])
const orderRows = results.filter((r) => !r.error).flatMap((r) => Object.entries(r.sets).map(([setName, s]) => [r.config, setName, s.order.ok ? 'ok' : 'MISMATCH', s.order.min_cosine_same_index.toFixed(4), s.order.max_cosine_neighbour.toFixed(4)]))
const cancelRows = results.filter((r) => !r.error && r.cancel).map((r) => [r.config, r.cancel.victim, `${r.cancel.others_fulfilled}/${r.cancel.others_total}`, r.cancel.array_request.outcome, `${r.cancel.array_request.ms} ms`, r.cancel.array_request.model_after_cancel])
const md = [
  `# Embedding: batch vs sequential · ${source.modelId} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, '',
  `Texts: ${chunks.length} corpus chunks and ${queries.length} retrieval queries. Each mode repeated ${repeats}×, median shown. sequential = one await per text; array = one embed({ text: [...] }); concurrent = every text as its own embed() under Promise.all. tok/s from the model's token counter over the wall time of the mode.`, '',
  '## Throughput', '', mdTable(headers, rows), '',
  ...(errorRows.length ? ['## Configs that could not embed the texts', '', mdTable(['config', 'error'], errorRows), ''] : []),
  '## Order of the array result (cosine of vector i against the sequential vector i, and against its neighbour)', '', mdTable(['config', 'set', 'order', 'min cosine same index', 'max cosine neighbour'], orderRows), '',
  '## Cancel by requestId (one of five concurrent single embeds; then a 3× corpus array request)', '', mdTable(['config', 'cancelled single', 'others completed', 'array request', 'array ms', 'model after'], cancelRows), '',
  '## Model load', '', mdTable(['config', 'backend', 'context', 'load ms'], results.map((r) => [r.config, r.backend ?? 'n/a', String(r.contextSize ?? 'n/a'), String(r.load_ms)])), '',
].join('\n')
await writeFile(join(out, 'results.json'), `${JSON.stringify({ model: source.modelId, chunks: chunks.length, queries: queries.length, repeats, results }, null, 2)}\n`)
await writeFile(join(out, 'report.md'), md)
console.log(`\nwritten: ${join(out, 'report.md')}`)
