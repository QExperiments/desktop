// Three turns through the direct engine: the excerpts must not accumulate.
import { createDirectChat } from '../../../src/runtime/direct/client.js'

const MODEL = '/Users/andrewkuncevich/.qvac/models/a11bf8b3fd47051d_Qwen3.5-0.8B-Q8_0.gguf'
const SYS = 'Answer only from the document excerpts. Be terse: at most 6 words.'
const FILLER = 'Meridian Components Inc. internal documentation, revision note, page footer. '.repeat(18)
const TURNS = [
  ['The P1 response SLA is four hours.', 'What is the P1 response SLA?'],
  ['The standard warranty is 24 months.', 'How long is the standard warranty?'],
  ['The Q2 win rate was 31 percent.', 'What was the Q2 win rate?'],
]

const chat = createDirectChat()
await chat.load({
  model: MODEL,
  config: { device: 'gpu', gpu_layers: 99, ctx_size: 8192, predict: 32, temp: 0, reasoning_budget: 0 },
  cacheDir: '/private/tmp/claude-501/-Users-andrewkuncevich-vs-code-projects-qvac/944bb6dd-64e2-494d-a319-f541fb40706e/scratchpad/kvdirect',
})
console.log('loaded\n')

const bare = []
for (const [i, [fact, question]] of TURNS.entries()) {
  const prompt = [{ role: 'user', content: `Document excerpts:\n\n[1] source: policies/doc.md\n${FILLER}\n${fact}\n${FILLER}\n\nQuestion: ${question}` }]
  let streamed = ''
  const out = await chat.chat({ session: 'smoke-1', system: SYS, bare: [...bare], prompt, onDelta: (t) => { streamed += t } })
  bare.push({ role: 'user', content: question }, { role: 'assistant', content: out.text })
  console.log(`ход ${i + 1}: контекст ${String(out.stats.CacheTokens).padStart(4)} · prefill ${String(out.stats.promptTokens).padStart(4)} · чекпоинт ${out.checkpoint} сообщ · "${out.text}" · streamed=${streamed.trim() === out.text}`)
}

// the checkpoint still remembers turn 1 without any excerpt in the cache
const recall = await chat.chat({ session: 'smoke-1', system: SYS, bare: [...bare], prompt: [{ role: 'user', content: 'What is the P1 response SLA?' }] })
console.log(`\nпамять без врезок: "${recall.text}" · контекст ${recall.stats.CacheTokens}`)
await chat.drop('smoke-1')
await chat.close()
