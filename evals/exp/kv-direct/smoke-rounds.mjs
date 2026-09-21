// Adapter + a second round on the same turn key (what a tool round costs).
import { createDirectChat } from '../../../src/runtime/direct/client.js'

const MODEL = '/Users/andrewkuncevich/.qvac/models/a11bf8b3fd47051d_Qwen3.5-0.8B-Q8_0.gguf'
const SYS = 'Answer only from the document excerpts. Be terse: at most 8 words.'
const FILLER = 'Meridian Components Inc. internal documentation, revision note, page footer. '.repeat(18)

const chat = createDirectChat()
await chat.load({
  model: MODEL,
  config: { device: 'gpu', gpu_layers: 99, ctx_size: 8192, predict: 64, temp: 0, reasoning_budget: 0, tools: true },
  cacheDir: '/private/tmp/claude-501/-Users-andrewkuncevich-vs-code-projects-qvac/944bb6dd-64e2-494d-a319-f541fb40706e/scratchpad/kvdirect',
})

const drain = async ({ run }) => {
  let streamed = ''
  for await (const event of run.events) if (event.type === 'contentDelta') streamed += event.text
  return { ...(await run.final), streamed }
}

// round 0: the turn with its excerpts
const r0 = await drain(chat.completion({
  session: 'rounds-1', system: SYS, bare: [],
  prompt: [{ role: 'user', content: `Document excerpts:\n\n[1] source: policies/doc.md\n${FILLER}\nThe P1 response SLA is four hours.\n${FILLER}\n\nQuestion: What is the P1 response SLA?` }],
}))
console.log(`раунд 0: prefill ${r0.stats.promptTokens} · reused ${r0.stats.cacheTokens} · "${r0.contentText}"`)

// round 1: a tool result appended to the same turn — only the delta is prefilled
const r1 = await drain(chat.completion({
  session: 'rounds-1', system: SYS, bare: [], resume: true,
  prompt: [
    { role: 'assistant', content: '<tool_call>{"name":"lookup_stock","arguments":{"sku":"SD-X4"}}</tool_call>' },
    { role: 'tool', content: '{"sku":"SD-X4","on_hand":118}\nNow answer the user in plain text from this result.' },
  ],
}))
console.log(`раунд 1: prefill ${r1.stats.promptTokens} · reused ${r1.stats.cacheTokens} · "${r1.contentText.slice(0, 60)}"`)

// tool markup is parsed, not streamed as prose
const r2 = await drain(chat.completion({
  session: 'rounds-1', system: SYS, bare: [], resume: true,
  resume: false,
  prompt: [{ role: 'user', content: 'How many SD-X4 are in stock? Use the tool.' }],
  tools: [{ name: 'lookup_stock', description: 'Stock on hand for a SKU.', parameters: { type: 'object', properties: { sku: { type: 'string', description: 'The SKU code' } }, required: ['sku'] } }],
}))
console.log(`раунд 2: toolCalls ${JSON.stringify(r2.toolCalls)}`)
console.log('   raw:', JSON.stringify(r2.streamed.slice(0, 300)))
console.log('   text:', JSON.stringify(r2.contentText.slice(0, 300)))

await chat.release('rounds-1')
await chat.drop('rounds-1')
await chat.close()
