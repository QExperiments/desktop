// One chat request the way a client makes it: POST /v1/chat/completions with
// stream: true, the eval run in `x-eval-run` (so the server writes a trace)
// and, for live categories, the session in `x-session-id`. Returns the text,
// the citations, the request id to join the trace on, the client-side time to
// the first content token and the wall time.
export const ask = async ({ base, messages, session, run, timeoutMs = 300_000 }) => {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const headers = { 'content-type': 'application/json', 'x-eval-run': run }
  if (session) headers['x-session-id'] = session

  const result = { status: 0, text: '', citations: [], grounded: null, requestId: null, usage: null, stats: null, ttftClientMs: null, wallMs: null, error: null }
  try {
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ messages, stream: true }), signal: controller.signal })
    result.status = response.status
    result.requestId = response.headers.get('x-request-id')
    if (!response.ok) {
      result.error = (await response.text()).slice(0, 500)
      return result
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
        const event = JSON.parse(line.slice(6))
        if (event.error) { result.error = event.error.message; continue }
        if (event.id) result.requestId = event.id
        const delta = event.choices?.[0]?.delta ?? {}
        if (delta.content) {
          if (result.ttftClientMs === null && delta.content.trim() !== '') result.ttftClientMs = Date.now() - startedAt
          result.text += delta.content
        }
        if (delta.citations) result.citations = delta.citations
        if (event.usage) result.usage = event.usage
        if (event.stats) result.stats = event.stats
        if (typeof event.grounded === 'boolean') result.grounded = event.grounded
      }
    }
  } catch (error) {
    result.error = error.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : error.message
  } finally {
    clearTimeout(timer)
    result.wallMs = Date.now() - startedAt
    result.text = result.text.trim()
  }
  return result
}
