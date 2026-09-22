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

// Everything up to the last `</think>` is reasoning, whether or not an opening
// tag came with it. The bare close is not a malformed answer: when
// `remove_thinking_from_context` strips a reasoning block out of the cached
// prefix, the next turn resumes with the template still inside that block, and
// the model closes it before writing. Measured on the 2026-09-21 full run: 25
// turns, none of them a first turn, all of them with a reused cache, none in a
// single-turn category. Keying on `<think>` alone let those through, and the
// answer reached the reader twice with the tag between the copies.
export const stripThinking = (text = '') => (text.includes('</think>') ? text.split('</think>').pop().trimStart() : text)

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

// The same for a token stream. A block can straddle any number of deltas and
// a tag can be split across two, so text is held back while it could still
// turn out to be the start of one.
//
// Two kinds of block are dropped. A tool call is markup the reader must never
// see. A reasoning block is the model's scratchpad: the SDK keeps it out of
// the content stream when it recognises it, and from the fourth turn of a
// cached session it stops recognising it (2026-09-21 run: 25 turns, all with
// a reused cache, none a first turn) and the tags arrive as content.
//
// A closing tag with no opener is the shape that case takes, and the stream
// cannot take back what it has already sent. Dropping the tag alone is what
// is possible here: the reader no longer sees markup, and the answer that
// precedes it stays. The message the API returns is corrected separately by
// `stripThinking`, which has the whole text and can cut the rehearsal.
const BLOCKS = [
  { open: '<tool_call>', close: '</tool_call>' },
  { open: '<think>', close: '</think>' },
]
const TAGS = BLOCKS.flatMap((block) => [block.open, block.close])

// How many characters at the end of `text` could still grow into `tag`.
const partial = (text, tag) => {
  for (let n = Math.min(text.length, tag.length - 1); n > 0; n--) if (tag.startsWith(text.slice(-n))) return n
  return 0
}
// The earliest tag in the buffer, and which one it is.
const firstTag = (buffer, tags) => {
  let at = -1
  let found = null
  for (const tag of tags) {
    const index = buffer.indexOf(tag)
    if (index !== -1 && (at === -1 || index < at)) { at = index; found = tag }
  }
  return { at, tag: found }
}
// The longest suffix that could still become any tag, so a tag split across
// two deltas is never emitted in halves.
const holdBack = (buffer, tags) => Math.max(0, ...tags.map((tag) => partial(buffer, tag)))

export const createMarkupFilter = (emit) => {
  let buffer = ''
  let closing = null
  const drain = (final) => {
    for (;;) {
      if (closing) {
        const end = buffer.indexOf(closing)
        if (end === -1) {
          // Still inside the block: keep only what could be the closing tag.
          buffer = final ? '' : buffer.slice(-Math.max(0, closing.length - 1))
          return
        }
        buffer = buffer.slice(end + closing.length)
        closing = null
        continue
      }
      const { at, tag } = firstTag(buffer, TAGS)
      if (at === -1) {
        const hold = final ? 0 : holdBack(buffer, TAGS)
        const out = hold ? buffer.slice(0, -hold) : buffer
        buffer = hold ? buffer.slice(-hold) : ''
        if (out) emit(out)
        return
      }
      if (at > 0) emit(buffer.slice(0, at))
      buffer = buffer.slice(at + tag.length)
      // An opener starts a block to swallow; a close with no opener is the
      // forced one, and only the tag itself can be dropped.
      closing = BLOCKS.find((block) => block.open === tag)?.close ?? null
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
