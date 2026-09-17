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
