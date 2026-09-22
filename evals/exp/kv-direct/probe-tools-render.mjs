// Replay the exact user turn the SDK answered in 669 tokens, straight through
// the addon, with and without the tool block.
import { readFileSync } from 'node:fs'
import { createDirectChat } from '../../../src/runtime/direct/client.js'
import { systemPrompt } from '../../../src/chat/answer.js'
import { toolSchemas, tools } from '../../../src/chat/tools.js'

const MODEL = '/Users/andrewkuncevich/.qvac/models/491e317866333013_Qwen3.5-2B-Q4_K_M.gguf'
const TURN = JSON.parse(readFileSync('/private/tmp/claude-501/-Users-andrewkuncevich-vs-code-projects-qvac/944bb6dd-64e2-494d-a319-f541fb40706e/scratchpad/real-turn.json', 'utf8'))
const SYS = systemPrompt('auto')

const chat = createDirectChat()
await chat.load({
  model: MODEL,
  config: { device: 'gpu', gpu_layers: 99, ctx_size: 16384, tools: true },
  cacheDir: '/private/tmp/claude-501/-Users-andrewkuncevich-vs-code-projects-qvac/944bb6dd-64e2-494d-a319-f541fb40706e/scratchpad/kvtools',
})

for (const [label, declared, temp] of [
  ['tools, temp 0.2', toolSchemas(tools), 0.2],
  ['tools, temp 0  ', toolSchemas(tools), 0],
  ['no tools, temp 0.2', [], 0.2],
]) {
  const key = `${declared.length}-${temp}`
  const out = await chat.chat({ session: key, system: SYS, bare: [], prompt: [TURN], tools: declared, params: { temp, predict: 4096 } })
  console.log(`${label}: stop=${out.stats.stopReason} gen=${out.stats.generatedTokens} prompt=${out.stats.promptTokens} · ${JSON.stringify((out.text || '').slice(0, 90))}`)
  await chat.drop(key)
}
await chat.close()
