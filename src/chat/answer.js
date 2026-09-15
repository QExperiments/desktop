// One place where a question becomes an answer. Retrieval, grounding and the
// citations array land here in the next stage; the voice loop and, later,
// /v1/chat/completions both go through it, so neither can quietly skip them.
const SYSTEM = [
  'You are Meridian Components\' internal assistant.',
  'Answer in the language of the question, in at most three sentences.',
  'If you do not have the answer, say so plainly instead of guessing a number.',
  // Qwen3 and Qwen3.5 read this as "skip the reasoning block". Models that do
  // not recognise it ignore it, and captureThinking catches them instead.
  '/no_think',
].join(' ')

export const answer = async (runtime, { question, ...params }) => {
  const { run, settle } = await runtime.completion({
    history: [{ role: 'system', content: SYSTEM }, { role: 'user', content: question }],
    // Reasoning models wrap their scratchpad in <think>. Captured separately it
    // stays out of contentText, so it is never read aloud or shown as an answer.
    captureThinking: true,
    generationParams: { temp: 0.2, predict: 320, ...params.generationParams },
    ...params,
  })

  try {
    const final = await run.final
    // Empty until the retrieval stage fills it: the shape is fixed by req 5.2
    // of the eval protocol, so callers can already rely on it.
    return { text: (final.contentText ?? '').trim(), citations: [] }
  } finally {
    settle()
  }
}
