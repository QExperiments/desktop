// Node side of the direct chat engine: owns the Bare child that holds the
// model and the per-session KV checkpoints (see worker.mjs for why the
// excerpts never reach the cache file).
//
// The child speaks newline-delimited JSON. The native addon writes its own
// lines to the same stdout, so anything that is not JSON with an `id` is
// logged and ignored rather than treated as a protocol error.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { logger } from '../../logger.js'
import { parseToolMarkup } from '../../chat/tool-markup.js'

const BARE = process.env.MERIDIAN_BARE_BIN || fileURLToPath(new URL('../../../node_modules/bare-runtime/bin/bare', import.meta.url))
const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url))

export const createDirectChat = ({ log = logger } = {}) => {
  // The worker's own chatter is not an event worth a log line at info level.
  const debug = log.debug ?? (() => {})
  let child = null
  let nextId = 1
  const pending = new Map()

  const start = () => {
    if (child) return child
    child = spawn(BARE, [WORKER], { cwd: fileURLToPath(new URL('../../..', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        receive(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text) => debug({ worker: text.trim() }, 'direct chat worker'))
    child.on('exit', (code) => {
      for (const [, entry] of pending) entry.reject(new Error(`direct chat worker exited with ${code}`))
      pending.clear()
      child = null
    })
    return child
  }

  const receive = (line) => {
    if (!line.trim()) return
    let message
    try { message = JSON.parse(line) } catch { return debug({ worker: line.trim() }, 'direct chat worker') }
    const entry = pending.get(message.id)
    if (!entry) return
    if (message.event === 'delta') return entry.onDelta?.(message.text)
    pending.delete(message.id)
    if (message.event === 'error') return entry.reject(Object.assign(new Error(message.message), { code: message.code }))
    entry.resolve(message.result)
  }

  const request = (op, payload = {}, onDelta) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject, onDelta })
    start().stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`)
  })

  // The addon reports the live context after the run; the rest of the codebase
  // speaks the SDK's names, where `cacheTokens` is what the turn did not have
  // to prefill.
  const asSdkStats = (stats = {}, cached = 0) => ({
    timeToFirstToken: stats.TTFT ?? null,
    tokensPerSecond: stats.TPS ?? null,
    promptTokens: stats.promptTokens ?? 0,
    generatedTokens: stats.generatedTokens ?? 0,
    // Same meaning the addon gives CacheTokens: the live KV at the end of the
    // turn, prompt and answer included, from which src/chat/stats.js takes
    // back the part that was already there. The addon's own number cannot be
    // used -- a turn stopped by `predict` is rolled back and it would report
    // the checkpoint alone -- so it is rebuilt from the checkpoint the worker
    // tracks plus what this turn put on top.
    cacheTokens: cached + (stats.promptTokens ?? 0) + (stats.generatedTokens ?? 0),
    stopReason: stats.stopReason ?? null,
  })

  // Same shape `runtime.completion` returns, so the agent loop in
  // src/chat/answer.js does not care which engine answered.
  const completion = ({ tools = [], ...rest }) => {
    // The declarations go to the worker (the model needs the block rendered
    // with the turn) and stay here too, to read the call back out of the text.
    const payload = { ...rest, tools }
    const queue = []
    let wake = null
    let finished = false
    const events = {
      async * [Symbol.asyncIterator] () {
        for (;;) {
          if (queue.length) { yield { type: 'contentDelta', text: queue.shift() }; continue }
          if (finished) return
          await new Promise((resolve) => { wake = resolve })
        }
      },
    }
    const release = () => { finished = true; wake?.(); wake = null }
    const final = request('chat', payload, (text) => { queue.push(text); wake?.(); wake = null })
      .then((result) => {
        release()
        return {
          contentText: result.text,
          thinkingText: result.thinking,
          // The agent loop stores the round's own words verbatim, tool markup
          // included, so the next round sees what it asked for.
          raw: { fullText: result.raw },
          stats: asSdkStats(result.stats, result.cached ?? 0),
          toolCalls: parseToolMarkup(result.raw, tools).calls,
          checkpoint: result.checkpoint,
          commit: result.commit ?? null,
        }
      }, (error) => { release(); throw error })
    return { run: { events, final }, settle: () => {} }
  }

  return {
    load: (options) => request('load', options),
    chat: ({ onDelta, ...payload }) => request('chat', payload, onDelta),
    completion,
    release: (session) => request('release', { session }),
    drop: (session) => request('drop', { session }),
    close: async () => {
      if (!child) return
      await request('close').catch(() => {})
      child = null
    },
    get running () { return child !== null },
  }
}
