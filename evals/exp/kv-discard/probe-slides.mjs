// Is there a factual counter for the sliding window, instead of inferring it
// from the token arithmetic? The addon's stats carry `contextSlides`
// ("Context-window slides for single requests") next to `CacheTokens`
// ("Final cache tokens"). This checks both against a third, physical
// measure: the size of the state file the addon writes for the cacheKey.
//
//   node_modules/bare-runtime/bin/bare evals/exp/kv-discard/probe-slides.mjs
import LlmLlamacpp from '@qvac/llm-llamacpp'
import fs from 'bare-fs'

const MODEL = '/Users/andrewkuncevich/.qvac/models/a11bf8b3fd47051d_Qwen3.5-0.8B-Q8_0.gguf'
const KEY = '/private/tmp/claude-501/-Users-andrewkuncevich-vs-code-projects-qvac/944bb6dd-64e2-494d-a319-f541fb40706e/scratchpad/slides-probe.bin'
try { fs.unlinkSync(KEY) } catch {}

const SYS = 'You are a terse assistant. Answer in at most 10 words.'
const FILLER = 'This paragraph is padding so the context fills quickly. '.repeat(14)
const bytes = () => { try { return fs.statSync(KEY).size } catch { return 0 } }

const model = new LlmLlamacpp({
  files: { model: [MODEL] },
  config: { device: 'gpu', gpu_layers: '99', ctx_size: '1024', predict: '16', reasoning_budget: '0', temp: '0', n_discarded: '256' },
  opts: { stats: true }, logger: null,
})
await model.load()

let previous = 0
const run = async (label, messages) => {
  const res = await model.run(messages, { cacheKey: KEY, saveCacheToDisk: true, prefill: true })
  await res.await()
  const s = res.stats ?? {}
  const size = bytes()
  const perToken = s.CacheTokens ? (size / s.CacheTokens).toFixed(0) : '-'
  console.log(`${label.padEnd(12)} CacheTokens ${String(s.CacheTokens).padStart(5)}  contextSlides ${String(s.contextSlides).padStart(2)}` +
    `  file ${String(size).padStart(9)} B  ${String(perToken).padStart(5)} B/token  Δfile ${String(size - previous).padStart(9)}`)
  previous = size
}

await run('prime', [{ role: 'system', content: SYS }])
for (const city of ['Lisbon', 'Oslo', 'Dakar', 'Quito', 'Perth', 'Riga', 'Tunis', 'Hanoi']) {
  await run(`fill ${city}`, [
    { role: 'user', content: `${FILLER}Remember: the ${city} warehouse is open.` },
    { role: 'assistant', content: 'Noted.' },
  ])
}
console.log('\nall stats keys:', JSON.stringify(Object.keys((await (await model.run([{ role: 'user', content: 'ok?' }], { cacheKey: KEY, saveCacheToDisk: false, prefill: true })).await(), 0) || {})))
await model.unload()
