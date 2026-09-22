import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMarkupFilter, parseToolMarkup, stripThinking } from '../../src/chat/tool-markup.js'

const tools = [{ name: 'lookup_stock', parameters: { properties: { sku: { type: 'string' }, quantity: { type: 'integer' }, exact: { type: 'boolean' } } } }]

test('the native Qwen3.5 form is read with the schema deciding each type', () => {
  const text = '<tool_call><function=lookup_stock><parameter=sku>SD-X4</parameter><parameter=quantity>12</parameter><parameter=exact>True</parameter></function></tool_call>'
  assert.deepEqual(parseToolMarkup(text, tools).calls, [{ name: 'lookup_stock', arguments: { sku: 'SD-X4', quantity: 12, exact: true } }])
})

test('the hermes JSON form is read too, and both survive a reasoning block', () => {
  const text = '<think><tool_call>{"name":"rehearsed"}</tool_call></think>Sure.<tool_call>{"name":"lookup_stock","arguments":{"sku":"CL-GW"}}</tool_call>'
  const { calls } = parseToolMarkup(text, tools)
  assert.deepEqual(calls, [{ name: 'lookup_stock', arguments: { sku: 'CL-GW' } }])
})

test('a broken call is an error, not a throw, and plain prose parses to nothing', () => {
  const { calls, errors } = parseToolMarkup('<tool_call><parameter=sku>SD-X4</parameter></tool_call>', tools)
  assert.equal(calls.length, 0)
  assert.match(errors[0].message, /missing <function=NAME>/)
  assert.deepEqual(parseToolMarkup('The warranty is 24 months.', tools), { calls: [], errors: [] })
})

test('stripThinking keeps what follows the last close marker', () => {
  assert.equal(stripThinking('<think>a</think>b'), 'b')
  assert.equal(stripThinking('plain'), 'plain')
})

test('the stream filter drops call blocks split across deltas', () => {
  const out = []
  const filter = createMarkupFilter((text) => out.push(text))
  for (const piece of ['Let me check. <tool', '_call>{"name": "lookup_', 'stock"}</tool_c', 'all> The answer is 14.']) filter.push(piece)
  filter.flush()
  assert.equal(out.join(''), 'Let me check.  The answer is 14.')
})

test('the stream filter holds back a tag that never completes and emits it at the end', () => {
  const out = []
  const filter = createMarkupFilter((text) => out.push(text))
  filter.push('done <too')
  assert.equal(out.join(''), 'done ')
  filter.flush()
  assert.equal(out.join(''), 'done <too')
})

test('an unterminated call block swallows the rest, as the final text strip does', () => {
  const out = []
  const filter = createMarkupFilter((text) => out.push(text))
  filter.push('<tool_call>{"name": "lookup_stock"')
  filter.flush()
  assert.equal(out.join(''), '')
})

test('a closing think tag with no opener still marks the end of the reasoning', () => {
  // `remove_thinking_from_context` removes the block from the cached prefix,
  // so the next turn resumes inside it and the model closes it before writing.
  // 25 turns of the 2026-09-21 full run looked like this, every one of them
  // with a reused cache and none of them a first turn.
  const forced = 'The warranty is **24 months** from ship date. </think>  The warranty is **24 months** from ship date.'
  assert.equal(stripThinking(forced), 'The warranty is **24 months** from ship date.')
  // the ordinary shape still works
  assert.equal(stripThinking('<think>weighing it up</think>The answer.'), 'The answer.')
  // and text with no reasoning at all is untouched
  assert.equal(stripThinking('Just the answer.'), 'Just the answer.')
  assert.equal(stripThinking(''), '')
})

test('the stream filter drops reasoning blocks and a forced closing tag', () => {
  const run = (...chunks) => {
    const out = []
    const filter = createMarkupFilter((text) => out.push(text))
    for (const chunk of chunks) filter.push(chunk)
    filter.flush()
    return out.join('')
  }
  // a whole reasoning block never reaches the reader
  assert.equal(run('<think>weighing it up</think>The answer.'), 'The answer.')
  // the forced close has no opener: the stream cannot take back what it sent,
  // so the tag goes and the text around it stays
  assert.equal(run('The answer. </think> The answer.'), 'The answer.  The answer.')
  // a tag split across deltas is not emitted in halves
  assert.equal(run('The answer. <', '/think', '> Rest.'), 'The answer.  Rest.')
  assert.equal(run('a<thi', 'nk>hidden</thi', 'nk>b'), 'ab')
  // tool calls keep working, and the two kinds of block do not confuse it
  assert.equal(run('before<tool_call>{"name":"x"}</tool_call>after'), 'beforeafter')
  assert.equal(run('<think>plan</think>text<tool_call>c</tool_call>end'), 'textend')
  // plain text is untouched and nothing is held back at the end
  assert.equal(run('Just the answer.'), 'Just the answer.')
  assert.equal(run('ends with a bare <'), 'ends with a bare <')
})
