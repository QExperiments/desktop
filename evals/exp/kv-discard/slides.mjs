#!/usr/bin/env node
// How often the addon's sliding window actually fired in a finished run, read
// off turns.jsonl. Nothing in the SDK reports a slide, so it is inferred from
// the size of the live KV, which is what the SDK's `cacheTokens` reports at
// the end of a turn (not the tokens it served from cache). With nothing
// removed the identity holds exactly:
//
//   cached(t) = cached(t-1) + prefill(t) + generated(t)
//
// so whatever is missing from the right-hand side left the KV during turn t.
//
// Two things remove tokens, so the size of the shrink is what tells them
// apart. The reasoning compactor (`remove_thinking_from_context`, on by
// default for the Qwen3 family) drops that turn's <think> span, a few hundred
// tokens; a slide drops exactly `n_discarded`. Runs with the window on send
// remove_thinking_from_context false, so there every shrink is a slide.
//
//   node evals/exp/kv-discard/slides.mjs <results dir>...
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const rows = async (dir) => (await readFile(join(dir, 'turns.jsonl'), 'utf8'))
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((t) => t.category === 'multiquery')

for (const arg of process.argv.slice(2)) {
  const dir = resolve(arg)
  const header = JSON.parse(await readFile(join(dir, 'header.json'), 'utf8'))
  const turns = await rows(dir)
  const ctx = Number(header.serverEnv?.MERIDIAN_CHAT_CTX ?? 0) || (header.config?.ctx?.[header.tier] ?? 16384)
  const discard = Number(header.serverEnv?.MERIDIAN_CHAT_DISCARD ?? 0) || 0

  const bySession = new Map()
  for (const t of turns) {
    const key = `${t.id}#${t.run}`
    if (!bySession.has(key)) bySession.set(key, [])
    bySession.get(key).push(t)
  }
  let slides = 0, dropped = 0, errors = 0, peak = 0
  const shrinks = []
  const firstSlideTurn = []
  for (const [, list] of bySession) {
    list.sort((a, b) => a.turn - b.turn)
    let previous = null, first = null
    for (const t of list) {
      if (t.error) { errors++; previous = null; continue }
      const cached = t.cached_tokens ?? 0
      const prefill = t.stats?.prefill_tokens ?? 0
      const generated = t.usage?.completion_tokens ?? 0
      const expected = previous === null ? null : previous + prefill + generated
      // A full replay (the KV was dropped and rebuilt) breaks the identity and
      // is not a slide; it shows as a prefill of the whole conversation.
      const replayed = prefill > cached / 2
      if (expected !== null && !replayed && expected - cached > 16) {
        const shrink = expected - cached
        shrinks.push(shrink)
        // A slide removes an exact multiple of n_discarded; the reasoning
        // compactor removes a <think> span, which is not.
        if (discard > 0 && shrink % discard === 0) {
          slides += shrink / discard
          dropped += shrink
          if (first === null) first = t.turn
        }
      }
      peak = Math.max(peak, cached)
      previous = cached
    }
    if (first !== null) firstSlideTurn.push(first)
  }
  const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null)
  console.log(`${basename(dir)}`)
  console.log(`  ctx_size ${ctx}, n_discarded ${discard}, sessions ${bySession.size}, turns ${turns.length}, errors ${errors}`)
  console.log(`  slides ${slides} of ${discard} tokens each, ${dropped} tokens dropped in all`)
  console.log(`  first slide at turn ${firstSlideTurn.length ? `${Math.min(...firstSlideTurn)}..${Math.max(...firstSlideTurn)} (median ${median(firstSlideTurn)}), in ${firstSlideTurn.length}/${bySession.size} sessions` : 'never'}`)
  console.log(`  peak live KV ${peak} of ${ctx}`)
  const buckets = shrinks.reduce((m, v) => { const k = `${Math.floor(v / 512) * 512}..`; m[k] = (m[k] ?? 0) + 1; return m }, {})
  console.log(`  KV shrink events ${shrinks.length}, sizes ${JSON.stringify(buckets)}`)
}
