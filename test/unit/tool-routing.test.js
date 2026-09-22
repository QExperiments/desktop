import assert from 'node:assert/strict'
import { test } from 'node:test'
import { routingPR, scoreTools } from '../../evals/lib/metrics/tools.mjs'

const trace = (...names) => ({ rounds: names.map((name) => ({ toolCalls: name ? [{ name, args: {} }] : [] })) })
const auto = [{ file: 'a.md' }]
const viaTool = [{ file: 'a.md', via: 'tool' }]

test('the tool the case wanted is a hit whatever else ran next to it', () => {
  assert.equal(scoreTools(trace('lookup_stock'), { tool: 'lookup_stock' }).routing, 'tp')
  assert.equal(scoreTools(trace('search_documents', 'lookup_stock'), { tool: 'lookup_stock' }).routing, 'tp')
})

test('search_documents the server already ran is `auto`, not a miss', () => {
  // Retrieval mode `tool` searches by itself on the first turn: the excerpts
  // are in front of the model, so there is nothing left to route.
  assert.equal(scoreTools(trace(null), { tool: 'search_documents' }, { hits: auto }).routing, 'auto')
  // No automatic excerpts, no call: a real miss.
  assert.equal(scoreTools(trace(null), { tool: 'search_documents' }, { hits: viaTool }).routing, 'fn')
  assert.equal(scoreTools(trace(null), { tool: 'search_documents' }).routing, 'fn')
  // Excerpts were there and the model still picked the wrong tool.
  assert.equal(scoreTools(trace('lookup_stock'), { tool: 'search_documents' }, { hits: auto }).routing, 'wrong')
})

test('search_documents counts as a tool the agent may call', () => {
  const scored = scoreTools(trace('search_documents'), { tool: 'search_documents' })
  assert.equal(scored.wrong_tool, false)
  assert.equal(scored.unknown_tool, false)
  assert.equal(scoreTools(trace('read_email'), { tool: null }).unknown_tool, true)
})

test('routingPR reports auto turns and keeps them out of precision and recall', () => {
  const rows = [{ routing: 'tp' }, { routing: 'tp' }, { routing: 'wrong' }, { routing: 'auto' }, { routing: 'auto' }, { routing: 'tn' }]
  const pr = routingPR(rows)
  assert.equal(pr.auto, 2)
  assert.equal(pr.recall, 2 / 3)
  assert.equal(pr.precision, 2 / 3)
})
