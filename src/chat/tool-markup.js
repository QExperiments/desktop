// Tool calls out of the model's text, for the direct engine.
//
// The SDK parses these itself and does not export the parser, so the two forms
// Qwen3.5 actually emits are handled here:
//
//   native XML  <tool_call><function=lookup_stock><parameter=sku>SD-X4</parameter></function></tool_call>
//   hermes JSON <tool_call>{"name":"lookup_stock","arguments":{"sku":"SD-X4"}}</tool_call>
//
// Anything inside a reasoning block is ignored: the model often rehearses a
// call there before deciding against it.
const CALL = /<tool_call>([\s\S]*?)<\/tool_call>/g
const FUNCTION = /<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/i
const PARAMETER = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/gi

export const stripThinking = (text = '') => (text.includes('<think>') ? text.split('</think>').pop() : text)

// Raw parameter text carries no JSON quoting in the XML form, so the tool's
// own schema says how to read it.
const coerce = (raw, type) => {
  const value = raw.trim()
  if (type === 'number' || type === 'integer') {
    const number = Number(value)
    if (!Number.isFinite(number)) throw new Error(`invalid ${type}: "${value}"`)
    if (type === 'integer' && !Number.isInteger(number)) throw new Error(`invalid integer: "${value}"`)
    return number
  }
  if (type === 'boolean') {
    const lowered = value.toLowerCase()
    if (lowered === 'true' || lowered === 'false') return lowered === 'true'
    throw new Error(`invalid boolean: "${value}"`)
  }
  if (type === 'array' || type === 'object') return JSON.parse(value)
  return value
}

const properties = (tool) => tool?.parameters?.properties ?? tool?.schema?.shape ?? {}

// The call blocks removed from text meant for a person. The SDK strips them
// when it owns the parsing; with the declarations in the system prompt it
// does not know they are there.
export const stripToolMarkup = (text = '') => text.replace(CALL, '').replace(/<\/?tool_call>/g, '').trim()

// The same for a token stream. A call block can straddle any number of
// deltas and its opening tag can be split across two, so text is held back
// while it could still turn out to be the start of `<tool_call>`.
const OPEN = '<tool_call>'
const CLOSE = '</tool_call>'
const partial = (text, tag) => {
  for (let n = Math.min(text.length, tag.length - 1); n > 0; n--) if (tag.startsWith(text.slice(-n))) return n
  return 0
}
export const createMarkupFilter = (emit) => {
  let buffer = ''
  let inside = false
  const drain = (final) => {
    for (;;) {
      if (inside) {
        const end = buffer.indexOf(CLOSE)
        if (end === -1) { buffer = final ? '' : buffer.slice(-(CLOSE.length - 1)); return }
        buffer = buffer.slice(end + CLOSE.length)
        inside = false
        continue
      }
      const start = buffer.indexOf(OPEN)
      if (start === -1) {
        const hold = final ? 0 : partial(buffer, OPEN)
        const out = hold ? buffer.slice(0, -hold) : buffer
        buffer = hold ? buffer.slice(-hold) : ''
        if (out) emit(out)
        return
      }
      if (start > 0) emit(buffer.slice(0, start))
      buffer = buffer.slice(start + OPEN.length)
      inside = true
    }
  }
  return { push: (text) => { buffer += text; drain(false) }, flush: () => drain(true) }
}

export const parseToolMarkup = (text = '', tools = []) => {
  const calls = []
  const errors = []
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  const cleaned = stripThinking(text)
  if (!cleaned.includes('<tool_call>')) return { calls, errors }

  for (const [, inner] of cleaned.matchAll(CALL)) {
    const body = inner.trim()
    try {
      if (body.startsWith('{')) {
        const parsed = JSON.parse(body)
        const name = parsed.name ?? parsed.function
        if (!name) throw new Error('tool call without a name')
        calls.push({ name, arguments: parsed.arguments ?? parsed.parameters ?? {} })
        continue
      }
      const fn = FUNCTION.exec(body)
      if (!fn) throw new Error('tool call missing <function=NAME>')
      const [, name, params] = fn
      const schema = properties(byName[name])
      const args = {}
      for (const [, key, raw] of params.matchAll(PARAMETER)) args[key] = coerce(raw, schema[key]?.type)
      calls.push({ name, arguments: args })
    } catch (error) {
      errors.push({ text: body.slice(0, 120), message: error.message })
    }
  }
  return { calls, errors }
}
