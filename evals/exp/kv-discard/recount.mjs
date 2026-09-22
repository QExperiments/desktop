#!/usr/bin/env node
// Rewrites the token bookkeeping of finished runs from their stored traces.
// Until 2026-09-21 `cacheTokens` (the live KV at the END of a round) was added
// to `promptTokens`, which counted the round's own prompt and answer twice and
// pushed `context_tokens` above `ctx_size`. The per-round stats in the traces
// are raw, so every affected field can be recomputed without re-running.
//
//   node evals/exp/kv-discard/recount.mjs <results dir>...   (writes turns.jsonl.bak)
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const reused = (s) => Math.max(0, (s?.cacheTokens ?? 0) - (s?.promptTokens ?? 0) - (s?.generatedTokens ?? 0))
const held = (s) => (s?.cacheTokens ?? 0) || ((s?.promptTokens ?? 0) + (s?.generatedTokens ?? 0))
const round3 = (v) => (Number.isFinite(v) ? Number(v.toFixed(3)) : null)

for (const arg of process.argv.slice(2)) {
  const dir = resolve(arg)
  const path = join(dir, 'turns.jsonl')
  const raw = await readFile(path, 'utf8')
  await writeFile(path + '.bak', raw)
  const rows = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  let touched = 0
  for (const row of rows) {
    if (!row.requestId) continue
    const trace = await readFile(join(dir, 'traces', `${row.requestId}.json`), 'utf8').then(JSON.parse).catch(() => null)
    if (!trace?.rounds?.length) continue
    const rounds = trace.rounds
    // The direct engine does not pass the addon's CacheTokens through: its
    // client already reports the checkpoint the turn started from, because a
    // turn stopped by `predict` is rolled back and the live size would lie.
    // So for those traces the reused part is the field itself.
    const direct = trace.retrieval?.engine === 'direct'
    const reusedOf = direct ? (s) => s?.cacheTokens ?? 0 : reused
    const heldOf = direct ? (s) => (s?.cacheTokens ?? 0) + (s?.promptTokens ?? 0) + (s?.generatedTokens ?? 0) : held
    const processed = rounds.reduce((t, r) => t + (r.stats?.promptTokens ?? 0), 0)
    const generated = rounds.reduce((t, r) => t + (r.stats?.generatedTokens ?? 0), 0)
    const cached = rounds.reduce((t, r) => t + reusedOf(r.stats), 0)
    const rw = trace.retrieval?.rewrite?.stats ?? null
    const rewritePrompt = (rw?.promptTokens ?? 0) + reusedOf(rw)
    const rewriteGenerated = rw?.generatedTokens ?? 0
    const promptTokens = processed + cached
    const context = rounds.reduce((max, r) => Math.max(max, heldOf(r.stats)), 0)
    row.usage = {
      prompt_tokens: promptTokens + rewritePrompt,
      completion_tokens: generated + rewriteGenerated,
      total_tokens: promptTokens + rewritePrompt + generated + rewriteGenerated,
      prompt_tokens_details: { cached_tokens: cached + reusedOf(rw) },
    }
    if (row.stats) {
      row.stats.context_tokens = context
      row.stats.cache_ratio = promptTokens > 0 ? round3(cached / promptTokens) : null
    }
    row.context_tokens = context || null
    row.cached_tokens = rounds[0]?.stats ? reusedOf(rounds[0].stats) : null
    touched++
  }
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  console.log(`${basename(dir)}: ${touched}/${rows.length} rows recounted`)
}
