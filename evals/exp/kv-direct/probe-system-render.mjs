// The direct engine rambles where the SDK answers. Hypothesis: the turn is
// rendered without a system message (it lives in the checkpoint), and the chat
// template behaves differently. A: system only in the checkpoint. C: system in
// the checkpoint and in the turn render.
import { createDirectChat } from '../../../src/runtime/direct/client.js'
import { systemPrompt } from '../../../src/chat/answer.js'

const MODEL = '/Users/andrewkuncevich/.qvac/models/491e317866333013_Qwen3.5-2B-Q4_K_M.gguf'
const SYS = systemPrompt('auto')
const FILLER = 'Meridian Components Inc. support policy, revision note, page footer. '.repeat(20)
const QUESTION = 'What is the P1 response SLA?'
const BLOCK = `Document excerpts:\n\n[1] source: faqs/support-sla-faq.html\n${FILLER}\nP1 first response is four hours, P2 is eight hours.\n${FILLER}\n\nQuestion: ${QUESTION}`

const chat = createDirectChat()
await chat.load({
  model: MODEL,
  config: { device: 'gpu', gpu_layers: 99, ctx_size: 16384, tools: true },
  cacheDir: '/private/tmp/claude-501/-Users-andrewkuncevich-vs-code-projects-qvac/944bb6dd-64e2-494d-a319-f541fb40706e/scratchpad/kvsys',
})

for (const [label, prompt] of [
  ['A: только пользовательское сообщение', [{ role: 'user', content: BLOCK }]],
  ['C: system повторён в рендере хода', [{ role: 'system', content: SYS }, { role: 'user', content: BLOCK }]],
]) {
  const out = await chat.chat({ session: `sys-${label[0]}`, system: SYS, bare: [], prompt, params: { temp: 0, predict: 4096 } })
  console.log(`${label}\n   stop=${out.stats.stopReason} gen=${out.stats.generatedTokens} prompt=${out.stats.promptTokens} · ответ: ${JSON.stringify((out.text || '').slice(0, 80))}`)
  await chat.drop(`sys-${label[0]}`)
}
await chat.close()
