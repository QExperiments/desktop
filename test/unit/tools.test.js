import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toolCitation, tools } from '../../src/chat/tools.js'

const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))

test('declares the two required tools with Zod parameter schemas', () => {
  assert.deepEqual(Object.keys(byName).sort(), ['list_documents', 'lookup_stock'])
  for (const tool of tools) assert.equal(typeof tool.parameters.safeParse, 'function')
  assert.equal(byName.lookup_stock.parameters.safeParse({ region: 'Mars' }).success, false)
  assert.equal(byName.lookup_stock.parameters.safeParse({ sku: 'SD-X4-001', region: 'EMEA' }).success, true)
})

test('lookup_stock returns the shipped figure for a known SKU', async () => {
  const result = await byName.lookup_stock.handler({ sku: 'SD-X4-001', region: 'EMEA' })
  assert.equal(result.asOf, '2026-06-30')
  assert.equal(result.matchCount, 1)
  assert.equal(result.matches[0].available, 14)
  assert.equal(result.matches[0].unitListPrice, 48500)
})

test('lookup_stock reports an unknown SKU as no record, with suggestions', async () => {
  const result = await byName.lookup_stock.handler({ sku: 'FOO-999' })
  assert.deepEqual(result.matches, [])
  assert.ok(Array.isArray(result.suggestions))
})

test('tool facts are cited as the tool plus its data date', () => {
  assert.deepEqual(toolCitation.lookup_stock, { file: 'stock-tool', asOf: '2026-06-30' })
})

test('search_documents is a factory bound to the caller\'s search and validates its query', async () => {
  const { searchDocumentsTool } = await import('../../src/chat/tools.js')
  const calls = []
  const tool = searchDocumentsTool({ run: async (query) => { calls.push(query); return { excerpts: [{ source: 'a.md', text: 'x' }], already_in_conversation: [] } } })
  assert.equal(tool.name, 'search_documents')
  assert.equal(tool.maxTries, 2)
  assert.equal(tool.parameters.safeParse({}).success, false)
  assert.equal(tool.parameters.safeParse({ query: 'extended warranty ServoDrive X4' }).success, true)
  const result = await tool.handler({ query: 'extended warranty ServoDrive X4' })
  assert.deepEqual(calls, ['extended warranty ServoDrive X4'])
  assert.equal(result.excerpts[0].source, 'a.md')
  // the shipped tool list is still the two required tools
  assert.deepEqual(tools.map((t) => t.name).sort(), ['list_documents', 'lookup_stock'])
})
