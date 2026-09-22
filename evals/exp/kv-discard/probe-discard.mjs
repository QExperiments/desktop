// Does modelConfig.n_discarded work, and what exactly does it drop?
// A tiny context (ctx_size) is filled turn by turn on one live sequence; each
// turn plants a fact. Past the end of the context the sliding window either
// throws (n_discarded 0) or discards tokens from the front and keeps going.
// Then three questions: the system secret, the oldest fact, the newest fact.
//
//   node_modules/bare-runtime/bin/bare evals/exp/kv-discard/probe-discard.mjs [n_discarded] [ctx_size]
import LlmLlamacpp from '@qvac/llm-llamacpp'

const MODEL = '/Users/andrewkuncevich/.qvac/models/a11bf8b3fd47051d_Qwen3.5-0.8B-Q8_0.gguf'
const DISCARD = Bare.argv[2] ?? '0'
const CTX = Bare.argv[3] ?? '1024'
const ROUNDS = Number(Bare.argv[4] ?? 1)

const SYS = 'You are a terse assistant. Answer in at most 10 words. SYSTEM SECRET: the vault code is ZULU-7.'
// ~150 tokens of filler per turn so the context fills in a handful of turns.
const FILLER = 'This paragraph is padding so the context fills quickly. '.repeat(14)
const FACTS = [
  ['Lisbon', 'the Lisbon warehouse holds 412 pallets'],
  ['Oslo', 'the Oslo warehouse holds 733 pallets'],
  ['Dakar', 'the Dakar warehouse holds 158 pallets'],
  ['Quito', 'the Quito warehouse holds 926 pallets'],
  ['Perth', 'the Perth warehouse holds 271 pallets'],
  ['Riga', 'the Riga warehouse holds 604 pallets'],
  ['Tunis', 'the Tunis warehouse holds 385 pallets'],
  ['Hanoi', 'the Hanoi warehouse holds 847 pallets'],
]

const model = new LlmLlamacpp({
  files: { model: [MODEL] },
  config: { device: 'gpu', gpu_layers: '99', ctx_size: CTX, predict: '32', reasoning_budget: '0', temp: '0', n_discarded: DISCARD },
  opts: { stats: true }, logger: null,
})
await model.load()
console.log(`\n### n_discarded=${DISCARD} ctx_size=${CTX}\n`)

const KEY = `/private/tmp/claude-501/-Users-andrewkuncevich-vs-code-projects-qvac/944bb6dd-64e2-494d-a319-f541fb40706e/scratchpad/discard-${DISCARD}-${CTX}.bin`

const run = async (label, messages, { prefill = false } = {}) => {
  try {
    const res = await model.run(messages, { cacheKey: KEY, saveCacheToDisk: false, prefill })
    let text = ''
    if (prefill) await res.await()
    else for await (const tok of res.iterate()) text += tok
    const s = res.stats ?? {}
    const brief = { prompt: s.promptTokens, gen: s.generatedTokens, cache: s.CacheTokens, stop: s.stopReason }
    console.log(`${label.padEnd(34)} ${JSON.stringify(brief)}${text ? '  -> ' + text.replace(/\s+/g, ' ').trim().slice(0, 90) : ''}`)
    return { ok: true, text, stats: s }
  } catch (error) {
    console.log(`${label.padEnd(34)} ERROR ${error.message}`)
    return { ok: false, error }
  }
}

// prime: system only
await run('prime [system]', [{ role: 'system', content: SYS }], { prefill: true })

// fill: one fact per turn, no generation, so the KV grows by a known amount
const plan = []
for (let r = 0; r < ROUNDS; r++) for (const [city, fact] of FACTS) plan.push([`${city}${r ? '-' + r : ''}`, r ? fact.replace(/\d+/, String(100 + r * 37 + city.length)) : fact])
for (const [city, fact] of plan) {
  const r = await run(`fill ${city}`, [
    { role: 'user', content: `${FILLER}Remember: ${fact}.` },
    { role: 'assistant', content: 'Noted.' },
  ], { prefill: true })
  if (!r.ok) break
}

// probe: what survived
await run('Q system secret', [{ role: 'user', content: 'What is the vault code? Answer with the code only.' }])
await run('Q oldest fact (Lisbon)', [{ role: 'user', content: 'How many pallets does the Lisbon warehouse hold? Number only.' }])
await run('Q newest fact (Hanoi)', [{ role: 'user', content: 'How many pallets does the Hanoi warehouse hold? Number only.' }])

await model.unload()
