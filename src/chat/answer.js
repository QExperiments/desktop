import { search } from '../rag/retrieve.mjs'

// One place where a question becomes an answer. Retrieval, grounding and the
// citations array land here; the voice loop and, later, /v1/chat/completions
// both go through it, so neither can quietly skip them.
const SYSTEM = [
  'You are Meridian Components\' internal assistant.',
  'Answer in the language of the question, in at most three sentences.',
  'If you do not have the answer, say so plainly instead of guessing a number.',
  // Qwen3 and Qwen3.5 read this as "skip the reasoning block". Models that do
  // not recognise it ignore it, and captureThinking catches them instead.
  '/no_think',
].join(' ')

// How many retrieved chunks are fed into the prompt as context.
const CHAT_TOPK = 3

// Builds a system-style context block from the retrieved chunks so the model
// grounds its answer in them instead of inventing facts.
function buildContext(results) {
  const parts = results.map((r, i) => `[${i + 1}] source: ${r.file}\n${r.content}`)
  return ['Use the retrieved context below to answer. Ground your answer in it; do not invent facts beyond it.', '', ...parts].join('\n\n')
}

// onDelta, when given, receives each content token as it is generated.
export const answer = async (runtime, { question, onDelta, ...params }) => {
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

  const { run, settle } = await runtime.completion({
    history: [{ role: 'system', content: system }, { role: 'user', content: question }],
    // Reasoning models wrap their scratchpad in  think>. Captured separately it
    // stays out of contentText, so it is never read aloud or shown as an answer.
    captureThinking: true,
    generationParams: { temp: 0.2, predict: 320, ...params.generationParams },
    ...params,
  })

  try {
    if (onDelta) for await (const event of run.events) if (event.type === 'contentDelta') onDelta(event.text)
    const final = await run.final
    // Shape fixed by req 5.2 of the eval protocol, so callers can rely on it.
    return { text: (final.contentText ?? '').trim(), citations }
  } finally {
    settle()
  }
}
