// Proof of the checkpoint scheme: the retrieval block never reaches the
// checkpoint file, so the context stops growing with excerpts.
//   K_stable : bare history only, advanced by prefill-only runs
//   K_turn   : a copy of K_stable, used for generation, deleted after
import LlmLlamacpp from '@qvac/llm-llamacpp'
import fs from 'bare-fs'

const MODEL = '/Users/andrewkuncevich/.qvac/models/a11bf8b3fd47051d_Qwen3.5-0.8B-Q8_0.gguf'
const DIR = '/private/tmp/claude-501/-Users-andrewkuncevich-vs-code-projects-qvac/944bb6dd-64e2-494d-a319-f541fb40706e/scratchpad/kvprobe'
const SYS = 'Answer only from the document excerpts. Be terse: at most 6 words.'

const FACTS = [
  ['The P1 response SLA is four hours.', 'What is the P1 response SLA?'],
  ['The standard warranty is 24 months.', 'How long is the standard warranty?'],
  ['The Atlas deal closed at 412000 dollars.', 'How much did the Atlas deal close at?'],
  ['The Q2 win rate was 31 percent.', 'What was the Q2 win rate?'],
]
const FILLER = 'Meridian Components Inc. internal documentation, revision note, page footer. '.repeat(18)
const excerpt = (fact) => `Document excerpts:\n\n[1] source: policies/doc.md\n${FILLER}\n${fact}\n${FILLER}\n\nQuestion: `

const model = new LlmLlamacpp({
  files: { model: [MODEL] },
  config: { device: 'gpu', gpu_layers: '99', ctx_size: '8192', predict: '24', reasoning_budget: '0', temp: '0' },
  opts: { stats: true }, logger: null,
})
await model.load()

const run = async (messages, opts) => {
  const res = await model.run(messages, opts)
  let text = ''
  if (opts.prefill) await res.await()
  else for await (const tok of res.iterate()) text += tok
  return { text: text.replace(/\s+/g, ' ').trim(), s: res.stats ?? {} }
}
const size = (f) => { try { return (fs.statSync(f).size / 1e6).toFixed(1) } catch { return '-' } }
const rm = (f) => { try { fs.unlinkSync(f) } catch {} }

// ---------- A: naive, one key, the whole turn is committed (what the SDK does)
const A = `${DIR}/naive.bin`; rm(A)
console.log('A. НАИВНО: один ключ, весь ход в кэше')
await run([{ role: 'system', content: SYS }], { cacheKey: A, saveCacheToDisk: true, prefill: true })
for (const [i, [fact, q]] of FACTS.entries()) {
  const { text, s } = await run([{ role: 'user', content: excerpt(fact) + q }], { cacheKey: A, saveCacheToDisk: true })
  console.log(`   ход ${i + 1}: контекст ${String(s.CacheTokens).padStart(5)} · prefill ${String(s.promptTokens).padStart(4)} · ${size(A)} MB · ${text.slice(0, 40)}`)
}

// ---------- B: checkpoint, excerpts never touch the file
const S = `${DIR}/stable.bin`, T = `${DIR}/turn.bin`; rm(S); rm(T)
console.log('\nB. ЧЕКПОИНТ: врезки только в одноразовом ключе')
await run([{ role: 'system', content: SYS }], { cacheKey: S, saveCacheToDisk: true, prefill: true })
for (const [i, [fact, q]] of FACTS.entries()) {
  rm(T); fs.copyFileSync(S, T)                                        // 1. копия чекпоинта
  const { text, s } = await run([{ role: 'user', content: excerpt(fact) + q }], { cacheKey: T, saveCacheToDisk: false })
  const { s: s2 } = await run([                                        // 2. в чекпоинт — только голая пара
    { role: 'user', content: q },
    { role: 'assistant', content: text },
  ], { cacheKey: S, saveCacheToDisk: true, prefill: true })
  console.log(`   ход ${i + 1}: контекст ${String(s.CacheTokens).padStart(5)} · prefill ${String(s.promptTokens).padStart(4)} · чекпоинт ${String(s2.CacheTokens).padStart(4)} ток / ${size(S)} MB · ${text.slice(0, 40)}`)
}

// ---------- C: did the checkpoint stay clean? ask an earlier question from it
rm(T); fs.copyFileSync(S, T)
const { text: recall } = await run([{ role: 'user', content: 'What is the P1 response SLA?' }], { cacheKey: T, saveCacheToDisk: false })
console.log(`\nC. память чекпоинта (ход 1 был про SLA): ${recall.slice(0, 60)}`)
await model.unload()
