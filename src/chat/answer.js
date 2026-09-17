import { search } from '../rag/retrieve.mjs'
import { toolCitation, tools } from './tools.js'

// One place where a question becomes an answer. Retrieval, grounding and the
// citations array land here; the voice loop and, later, /v1/chat/completions
// both go through it, so neither can quietly skip them.
const SYSTEM = [
  'You are Meridian Components\' internal assistant.',
  'Answer in the language of the question, in at most three sentences.',
  'If you do not have the answer, say so plainly instead of guessing a number.',
  'Tools: lookup_stock for stock, availability or lead time; list_documents for the list of corpus files.',
  'Call a tool, read its result, then answer the user in plain text. Repeat a call only with different arguments.',
  // Qwen3 and Qwen3.5 read this as "skip the reasoning block". Models that do
  // not recognise it ignore it, and captureThinking catches them instead.
  '/no_think',
].join(' ')

// How many retrieved chunks are fed into the prompt as context.
const CHAT_TOPK = 3
// Hard stop for the tool loop, whatever the per-tool limits add up to.
const MAX_TOOL_ROUNDS = 3

// Every tool result goes back with this line. A small model otherwise reads
// the result as a cue to call the tool again instead of writing the answer.
const afterTool = (result) => `${JSON.stringify(result)}\nNow answer the user in plain text from this result.`

const toolByName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))

// Builds a system-style context block from the retrieved chunks so the model
// grounds its answer in them instead of inventing facts.
function buildContext(results) {
  const parts = results.map((r, i) => `[${i + 1}] source: ${r.file}\n${r.content}`)
  return ['Use the retrieved context below to answer. Ground your answer in it; do not invent facts beyond it.', 'The context never holds stock quantities, availability or lead times; call lookup_stock for those.', ...parts].join('\n\n')
}

// prior: earlier user/assistant turns from the client. session: a key under
// which the SDK keeps this conversation's KV state between calls (req 6.3).
// onDelta, when given, receives each content token as it is generated.
export const answer = async (runtime, { question, prior = [], session, onDelta, ...params }) => {
  // Retrieve fresh context on every request. If retrieval is unavailable, fall
  // back to a plain answer rather than failing the whole request.
  let citations = []
  let contextBlock = ''
  if (question) {
    try {
      const results = await search(question, CHAT_TOPK)
      if (results.length > 0) {
        contextBlock = buildContext(results)
        citations = results.map((r) => ({ file: r.file, score: r.score }))
      }
    } catch (err) {
      runtime.log?.error?.(err)
    }
  }

  const system = contextBlock ? `${SYSTEM}\n\n${contextBlock}` : SYSTEM

  const history = [
    { role: 'system', content: system },
    ...prior.map(({ role, content }) => ({ role, content })),
    { role: 'user', content: question },
  ]
  // The SDK caches per key and per system prompt, and sends only the messages
  // it has not seen under that key. Rounds of the tool loop below share it too.
  const kvCache = session ? `meridian-${String(session).replace(/[^\w.-]/g, '_').slice(0, 64)}` : undefined

  // Agent loop: each round is one completion. A round that asks for tools gets
  // their results appended as `tool` messages and the next round starts; the
  // loop ends on the first round with no tool calls or at MAX_TOOL_ROUNDS.
  // Each tool allows maxTries calls per question; past that the model gets an
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
        // Shape fixed by req 5.2 of the eval protocol, so callers can rely on it.
        return { text: (final.contentText ?? '').trim(), citations }
      }

      history.push({ role: 'assistant', content: final.raw?.fullText ?? '' })
      for (const call of calls) {
        const tool = toolByName[call.name]
        tries[call.name] = (tries[call.name] ?? 0) + 1
        const result = !tool ? { error: `unknown tool ${call.name}` }
          : tries[call.name] > tool.maxTries ? { error: `${call.name} was already called for this question; use its earlier result` }
          : await call.invoke()
        history.push({ role: 'tool', content: afterTool(result) })
        const cite = toolCitation[call.name]
        if (cite && !citations.some((c) => c.file === cite.file)) citations.push(cite)
      }
    } finally {
      settle()
    }
  }
}
