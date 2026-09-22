// The live server sees no cache reuse; this reproduces its exact shape:
// a long system prompt, a long excerpt block, two turns.
import { createDirectChat } from '../../../src/runtime/direct/client.js'
import { systemPrompt } from '../../../src/chat/answer.js'

const MODEL = '/Users/andrewkuncevich/.qvac/models/491e317866333013_Qwen3.5-2B-Q4_K_M.gguf'
const SYS = systemPrompt('auto')
const FILLER = 'Meridian Components Inc. support policy, revision note, page footer. '.repeat(20)

const chat = createDirectChat()
await chat.load({
  model: MODEL,
  config: { device: 'gpu', gpu_layers: 99, ctx_size: 16384, tools: true },
  cacheDir: '/private/tmp/claude-501/-Users-andrewkuncevich-vs-code-projects-qvac/944bb6dd-64e2-494d-a319-f541fb40706e/scratchpad/kvshape',
})
console.log('system prompt chars:', SYS.length)

const bare = []
for (const [i, q] of ['What is the P1 response SLA?', 'And for P2?'].entries()) {
  const out = await chat.chat({
    session: 'shape-1', system: SYS, bare: [...bare],
    prompt: [{ role: 'user', content: `Document excerpts:\n\n[1] source: faqs/support-sla-faq.html\n${FILLER}\nP1 first response is four hours, P2 is eight hours.\n${FILLER}\n\nQuestion: ${q}` }],
    params: { temp: 0, predict: 4096 },
  })
  console.log(`ход ${i + 1}: stop=${out.stats.stopReason} gen=${out.stats.generatedTokens} prompt=${out.stats.promptTokens} · text=${JSON.stringify((out.text || '').slice(0, 60))}`)
  console.log('   raw tail:', JSON.stringify(out.raw.slice(-160)))
  bare.push({ role: 'user', content: q }, { role: 'assistant', content: out.text || '(empty)' })
}
await chat.drop('shape-1')
await chat.close()
