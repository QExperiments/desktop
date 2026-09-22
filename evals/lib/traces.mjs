import { cp, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// The server writes data/traces/<run>/<requestId>.json for requests carrying
// x-eval-run. The runner reads each trace right after the answer and, at the
// end, copies the whole run directory next to the results.
export const readTrace = async (tracesDir, run, requestId) => {
  if (!requestId) return null
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return JSON.parse(await readFile(join(tracesDir, run, `${requestId}.json`), 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      // The server writes the trace after the last SSE chunk; give it a moment.
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  return null
}

export const copyTraces = (tracesDir, run, to) => cp(join(tracesDir, run), to, { recursive: true }).catch(() => {})

// The excerpts and tool results the model was shown on this turn, as text:
// the judge's context and the base of the `grounded` check.
export const contextOf = (trace) => {
  if (!trace) return { excerpts: '', toolResults: '', hits: [] }
  const messages = trace.messages ?? []
  const user = messages.find((m) => m.role === 'user')?.content ?? ''
  const excerpts = user.startsWith('Document excerpts:') ? user.replace(/\n\nQuestion: [\s\S]*$/, '').replace(/^Document excerpts:\n\n/, '') : ''
  const toolResults = messages.filter((m) => m.role === 'tool').map((m) => m.content.replace(/\nNow answer the user in plain text from this result\.$/, '')).join('\n')
  return { excerpts, toolResults, hits: trace.hits ?? [] }
}
