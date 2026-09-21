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
