import { search } from '../rag/retrieve.mjs'
import { toolCitation, tools } from './tools.js'

// One place where a query becomes an answer. Retrieval, grounding and the
// citations array land here; the voice loop and /v1/chat/completions both go
// through it, so neither can quietly skip them.
//
// The system prompt is fixed. The SDK names a session's KV-cache file after a
// hash of the system prompt plus the tool block, and under that key it sends
// the model only the messages it has not seen yet. Retrieved context therefore
// travels inside the user turn, never in the system prompt: one file per
// session, and turn N pays prefill for turn N alone (req 6.3).
export const SYSTEM = [
  'You are Meridian Components\' internal assistant.',
  'Answer in the language of the question, in at most three sentences.',
  'A user message may open with excerpts from the company documents. Ground your answer in them and in earlier excerpts of this conversation; do not invent facts beyond them.',
  'The documents never hold stock quantities, availability or lead times; call lookup_stock for those.',
  'Tools: lookup_stock for stock, availability or lead time; list_documents for the list of corpus files.',
  'Call a tool, read its result, then answer the user in plain text. Repeat a call only with different arguments.',
  'If you do not have the answer, say so plainly instead of guessing a number.',
  // Qwen3 and Qwen3.5 read this as "skip the reasoning block". Models that do
  // not recognise it ignore it, and captureThinking catches them instead.
  '/no_think',
].join(' ')

// How many retrieved chunks are fed into the prompt as context.
const CHAT_TOPK = 3
// Hard stop for the tool loop, whatever the per-tool limits add up to.
const MAX_TOOL_ROUNDS = 3

// The SDK's cache key for a session. Same alphabet sessions.js accepts.
export const kvCacheKey = (session) => `meridian-${String(session).replace(/[^\w.-]/g, '_').slice(0, 64)}`

// Every tool result goes back with this line. A small model otherwise reads
// the result as a cue to call the tool again instead of writing the answer.
const afterTool = (result) => `${JSON.stringify(result)}\nNow answer the user in plain text from this result.`

const toolByName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))

// The user turn as the model sees it: fresh excerpts first, the question last.
// Chunks shown earlier in the session are already in the model's context and
// are not repeated; they still count as citations for this answer.
const buildUserTurn = (hits, query) => {
  const fresh = hits.filter((hit) => !hit.reused)
  if (!fresh.length) return query
  const parts = fresh.map((hit, i) => `[${i + 1}] source: ${hit.file}\n${hit.content}`)
  return ['Document excerpts:', ...parts, `Question: ${query}`].join('\n\n')
}

// messages: the conversation so far, exactly as the model saw it (a session's
// stored turns, or the client's history), ending with the new user query.
// shown: chunk ids already in this session's context. session: the key under
// which the SDK keeps the KV state between calls. onDelta receives each
// content token as it is generated.
//
// Returns the answer plus everything a session has to store to replay this
// turn: the messages added (user turn with excerpts, tool rounds, the final
// answer), the chunks shown, and the retrieval hits.
export const answer = async (runtime, { messages, session, shown = [], onDelta, ...params }) => {
  const query = messages.at(-1)?.role === 'user' ? messages.at(-1).content : ''
  const prior = messages.slice(0, messages.at(-1)?.role === 'user' ? -1 : undefined).map(({ role, content }) => ({ role, content }))
  const seen = new Set(shown)

  // Retrieve fresh context on every request. If retrieval is unavailable, fall
  // back to a plain answer rather than failing the whole request.
  let hits = []
  if (query) {
    try {
      const results = await search(query, CHAT_TOPK)
      hits = results.slice(0, CHAT_TOPK).map((r) => {
        const id = `${r.file}::${r.chunkIndex}`
        return { id, file: r.file, chunkIndex: r.chunkIndex, score: r.score, content: r.content, reused: seen.has(id) }
      })
    } catch (err) {
      runtime.log?.error?.(err)
    }
  }

  const citations = hits.map((hit) => ({ file: hit.file, score: hit.score, ...(hit.reused ? { reused: true } : {}) }))
  // Messages this turn adds to the conversation, in the order the model sees them.
  const turn = [{ role: 'user', content: buildUserTurn(hits, query) }]
  const history = [{ role: 'system', content: SYSTEM }, ...prior, ...turn]
  const kvCache = session ? kvCacheKey(session) : undefined

  // Agent loop: each round is one completion. A round that asks for tools gets
  // their results appended as `tool` messages and the next round starts; the
  // loop ends on the first round with no tool calls or at MAX_TOOL_ROUNDS.
  // Each tool allows maxTries calls per query; past that the model gets an
  // error instead of a result. Tools stay declared in every round: without
  // them the model still writes tool-call markup, which then streams as text.
  const tries = {}
  for (let round = 0; ; round++) {
    const { run, settle } = await runtime.completion({
      history,
      tools,
      kvCache,
      // Reasoning models wrap their scratchpad in <think>. Captured separately it
      // stays out of contentText, so it is never read aloud or shown as an answer.
      captureThinking: true,
      generationParams: { temp: 0.2, predict: 320, ...params.generationParams },
      ...params,
    })

    try {
      if (onDelta) for await (const event of run.events) if (event.type === 'contentDelta') onDelta(event.text)
      const final = await run.final
      const calls = (await final.toolCalls) ?? []
      if (calls.length === 0 || round >= MAX_TOOL_ROUNDS) {
        const text = (final.contentText ?? '').trim()
        turn.push({ role: 'assistant', content: text })
        // Shape fixed by req 5.2 of the eval protocol, so callers can rely on it.
        return { text, citations, messages: turn, hits }
      }

      const push = (message) => { history.push(message); turn.push(message) }
      push({ role: 'assistant', content: final.raw?.fullText ?? '' })
      for (const call of calls) {
        const tool = toolByName[call.name]
        tries[call.name] = (tries[call.name] ?? 0) + 1
        const result = !tool ? { error: `unknown tool ${call.name}` }
          : tries[call.name] > tool.maxTries ? { error: `${call.name} was already called for this question; use its earlier result` }
          : await call.invoke()
        push({ role: 'tool', content: afterTool(result) })
        const cite = toolCitation[call.name]
        if (cite && !citations.some((c) => c.file === cite.file)) citations.push(cite)
      }
    } finally {
      settle()
    }
  }
}
