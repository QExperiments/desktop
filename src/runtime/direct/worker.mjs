// Chat straight through the llama.cpp addon, so the KV cache holds the bare
// conversation and never the retrieved excerpts.
//
// The SDK commits whatever it sent into the session's cache file, excerpts
// included: that is why a turn costs a chunk block of context forever
// (ADR-014). The addon underneath is more flexible than the SDK surface --
// `saveCacheToDisk` is decided per call and `prefill` evaluates a prompt
// without generating -- so a session keeps two files:
//
//   <session>.bin       the checkpoint: the system prompt plus the bare
//                       question/answer pairs, advanced by prefill-only runs
//   <session>.turn.bin  a copy of it, used for this turn's generation and
//                       removed afterwards, so the excerpts die with it
//
// Measured on the addon (docs/todo-5.md): calling again with the same cacheKey
// continues the live sequence, while switching the key reloads state from that
// file. The copy is what gives every turn a clean starting point.
//
// Protocol: newline-delimited JSON over stdin/stdout, one `id` per request.
// The native addon prints to stdout too, so the reader on the other side
// ignores anything that is not JSON carrying an `id`.
import LlmLlamacpp from '@qvac/llm-llamacpp'
import fs from 'bare-fs'
import path from 'bare-path'
import process from 'bare-process'

let model = null
let dir = ''
// Per session: how many of the bare messages the checkpoint already holds.
const sessions = new Map()

const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)
const unlink = (file) => { try { fs.unlinkSync(file) } catch {} }
const exists = (file) => { try { fs.accessSync(file); return true } catch { return false } }

// The addon takes every config value as a string (the SDK does the same in
// transformLlmConfig), and needs a device even when the model config omits it.
const addonConfig = (config) => Object.fromEntries(
  Object.entries(config).map(([key, value]) => [key, typeof value === 'boolean' || typeof value === 'number' ? String(value) : value]))

const run = async (messages, options, onDelta) => {
  const response = await model.run(messages, options)
  let raw = ''
  if (options.prefill) {
    await response.await()
  } else {
    let shown = ''
    for await (const token of response.iterate()) {
      raw += token
      // Thinking stays out of the answer: everything up to the last closing
      // marker belongs to the reasoning channel.
      const visible = raw.includes('<think>') ? (raw.includes('</think>') ? raw.split('</think>').pop() : '') : raw
      if (visible.length > shown.length) {
        onDelta?.(visible.slice(shown.length))
        shown = visible
      }
    }
  }
  return { raw, stats: response.stats ?? {} }
}

// A reasoning block that never closed means the budget ran out mid-thought:
// there is no answer, which is how the SDK's normalizer reads it too.
const answer = (raw) => (raw.includes('<think>')
  ? (raw.includes('</think>') ? raw.split('</think>').pop() : '')
  : raw).trim()
const thinking = (raw) => (raw.includes('<think>') ? raw.split('</think>').slice(0, -1).join('</think>') : '')

const ops = {
  async load ({ model: file, config, cacheDir }) {
    dir = cacheDir
    fs.mkdirSync(dir, { recursive: true })
    model = new LlmLlamacpp({ files: { model: [file] }, config: addonConfig(config), logger: null, opts: { stats: true } })
    await model.load()
    return { loaded: true }
  },

  // One turn, or one round of it. `bare` is the whole conversation without
  // excerpts; `prompt` is what this round adds, excerpts included. Everything
  // in `bare` the checkpoint does not hold yet is committed first, in one
  // prefill. A round past the first (`resume`) continues the live sequence on
  // the turn key instead of starting from a fresh copy, so a tool result costs
  // only its own tokens.
  async chat ({ id, session, system, bare = [], prompt, params = {}, resume = false, tools = [] }, onDelta) {
    const stable = path.join(dir, `${session}.bin`)
    let state = sessions.get(session)

    if (!state || !exists(stable)) {
      unlink(stable)
      const primed = await run([{ role: 'system', content: system }], { cacheKey: stable, saveCacheToDisk: true, prefill: true })
      // How much the turn will not have to prefill. The addon reports the live
      // size at the end of a run, and a turn stopped by `predict` is rolled
      // back to this point, so the checkpoint's own runs are the only reliable
      // place to read it.
      state = { committed: 0, seq: 0, turn: null, cached: primed.stats.CacheTokens ?? 0 }
      sessions.set(session, state)
    }

    let commit = null
    const pending = bare.slice(state.committed)
    if (pending.length) {
      const { stats } = await run(pending, { cacheKey: stable, saveCacheToDisk: true, prefill: true })
      state.committed = bare.length
      state.cached = stats.CacheTokens ?? state.cached
      commit = { messages: pending.length, context: state.cached }
    }

    // A fresh key per turn, not a fresh file under the same name: the addon
    // only rereads state when the cacheKey string changes, so reusing the name
    // would silently continue the previous turn's live sequence -- excerpts
    // and all.
    if (!resume) {
      const previous = state.turn
      state.turn = path.join(dir, `${session}.turn.${++state.seq}.bin`)
      fs.copyFileSync(stable, state.turn)
      if (previous) unlink(previous)
    }
    const turn = state.turn
    // Tool definitions ride with the turn, never with the checkpoint: Qwen3.5
    // anchors its tool block on the last user query, so a prime that has no
    // user turn cannot render one. They land in the scratch key and go with it.
    const payload = resume || !tools.length
      ? prompt
      : [...tools.map((tool) => ({ type: 'function', ...tool })), ...prompt]
    try {
      const { raw, stats } = await run(payload, {
        cacheKey: turn,
        saveCacheToDisk: false,
        // Model config goes to the addon as strings; generation params keep
        // their own types (the addon rejects a stringified `temp`).
        ...(Object.keys(params).length ? { generationParams: params } : {}),
      }, onDelta)
      return { text: answer(raw), thinking: thinking(raw), raw, stats, commit, cached: state.cached, checkpoint: state.committed }
    } catch (error) {
      unlink(turn)
      throw error
    }
  },

  // End of turn: the scratch key and everything the excerpts put in it go away.
  // The next turn mints a new one, so nothing here is needed again.
  async release ({ session }) {
    const state = sessions.get(session)
    if (state?.turn) { unlink(state.turn); state.turn = null }
    return { released: true }
  },

  async drop ({ session }) {
    const state = sessions.get(session)
    if (state?.turn) unlink(state.turn)
    sessions.delete(session)
    unlink(path.join(dir, `${session}.bin`))
    return { dropped: true }
  },

  async close () {
    await model?.unload()
    model = null
    return { closed: true }
  },
}

let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (line.trim()) handle(line)
  }
})

const handle = async (line) => {
  let request
  try { request = JSON.parse(line) } catch { return }
  const { id, op } = request
  try {
    const result = await ops[op]?.(request, (text) => send({ id, event: 'delta', text }))
    if (result === undefined) throw new Error(`unknown op: ${op}`)
    send({ id, event: 'done', result })
    if (op === 'close') process.exit(0)
  } catch (error) {
    send({ id, event: 'error', message: error.message, code: error.code ?? null })
  }
}
