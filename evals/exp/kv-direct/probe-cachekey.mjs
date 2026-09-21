// Does the addon reload KV state from the cacheKey file, or continue from the
// live sequence? Everything about the checkpoint scheme depends on the answer.
// Run: node_modules/bare-runtime/bin/bare scratchpad/kv-probe.mjs
import LlmLlamacpp from '@qvac/llm-llamacpp'
import fs from 'bare-fs'

const MODEL = '/Users/andrewkuncevich/.qvac/models/a11bf8b3fd47051d_Qwen3.5-0.8B-Q8_0.gguf'
const DIR = '/private/tmp/claude-501/-Users-andrewkuncevich-vs-code-projects-qvac/944bb6dd-64e2-494d-a319-f541fb40706e/scratchpad/kvprobe'
const STABLE = `${DIR}/stable.bin`
const COPY = `${DIR}/copy.bin`
for (const f of [STABLE, COPY]) { try { fs.unlinkSync(f) } catch {} }

const SYS = 'You are a terse assistant. Answer in at most 8 words.'
const stat = (f) => { try { const s = fs.statSync(f); return `${(s.size / 1e6).toFixed(1)} MB` } catch { return 'absent' } }

const model = new LlmLlamacpp({
  files: { model: [MODEL] },
  config: { device: 'gpu', gpu_layers: '99', ctx_size: '4096', predict: '40', reasoning_budget: '0', temp: '0' },
  opts: { stats: true }, logger: null,
})
await model.load()
console.log('model loaded\n')

const run = async (label, messages, opts) => {
  const res = await model.run(messages, opts)
  let text = ''
  if (opts.prefill) await res.await()
  else for await (const tok of res.iterate()) text += tok
  const s = res.stats ?? {}
  console.log(`--- ${label}`)
  console.log('    opts   :', JSON.stringify({ ...opts, cacheKey: opts.cacheKey?.split('/').pop() }))
  console.log('    stats  :', JSON.stringify(s))
  if (text) console.log('    answer :', text.replace(/\s+/g, ' ').trim().slice(0, 120))
  console.log('    stable :', stat(STABLE), '| copy:', stat(COPY))
  return { text, stats: s }
}

// 1. prime the checkpoint with a fact, prefill only, save
await run('T1 prime+save  [sys, "code word BANANA", "Noted."]', [
  { role: 'system', content: SYS },
  { role: 'user', content: 'Remember this: my code word is BANANA.' },
  { role: 'assistant', content: 'Noted.' },
], { cacheKey: STABLE, saveCacheToDisk: true, prefill: true })

// 2. delta-only turn on the same key, do NOT save. Plants a second fact.
await run('T2 delta, save=false  ["fruit is KIWI. what is my code word?"]', [
  { role: 'user', content: 'Also my fruit is KIWI. What is my code word?' },
], { cacheKey: STABLE, saveCacheToDisk: false })

// 3. another delta on the same key. If the live sequence continued, the model
//    knows KIWI; if the file was reloaded, it never saw that message.
await run('T3 delta again  ["what is my fruit?"]', [
  { role: 'user', content: 'What is my fruit?' },
], { cacheKey: STABLE, saveCacheToDisk: false })

// 4. copy the checkpoint and resume from the copy
fs.copyFileSync(STABLE, COPY)
await run('T4 delta on COPY  ["what is my code word?"]', [
  { role: 'user', content: 'What is my code word?' },
], { cacheKey: COPY, saveCacheToDisk: false })

// 5. advance the checkpoint with a bare pair, prefill only, save
await run('T5 prefill+save bare pair on STABLE', [
  { role: 'user', content: 'What is my code word?' },
  { role: 'assistant', content: 'BANANA.' },
], { cacheKey: STABLE, saveCacheToDisk: true, prefill: true })

await model.unload()
console.log('\ndone')
