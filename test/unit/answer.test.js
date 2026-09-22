import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanRewrite, compactionBase, estimateTokens, rawQuery, replayHistory, rewriteTranscript, roundParams, systemPrompt, visibleChunks } from '../../src/chat/answer.js'

test('the system prompt names search_documents in tool mode only', () => {
  assert.match(systemPrompt('tool'), /search_documents/)
  assert.doesNotMatch(systemPrompt('auto'), /search_documents/)
  // both keep the stock rule and the no-guessing rule
  for (const mode of ['auto', 'tool']) {
    assert.match(systemPrompt(mode), /lookup_stock/)
    assert.match(systemPrompt(mode), /say so plainly/)
  }
})

test('rawQuery strips the excerpts a stored user turn opens with', () => {
  assert.equal(rawQuery('Document excerpts:\n\n[1] source: a.md\nsome text\n\nQuestion: What is the SLA?'), 'What is the SLA?')
  assert.equal(rawQuery('What is the SLA?'), 'What is the SLA?')
  assert.equal(rawQuery('Document excerpts:\n\n[1] source: a.md\nQuestion: inside a chunk\n\nQuestion: the real one'), 'the real one')
})

test('cleanRewrite keeps the first usable line and falls back to the original', () => {
  assert.deepEqual(cleanRewrite('"Query: ServoDrive X4 extended warranty"\nsecond line', 'and the extended one?'), { query: 'ServoDrive X4 extended warranty', used: true })
  assert.deepEqual(cleanRewrite('\n  Standalone search query: P1 SLA enterprise  \n', 'x'), { query: 'P1 SLA enterprise', used: true })
  assert.deepEqual(cleanRewrite('', 'and the extended one?'), { query: 'and the extended one?', used: false })
  assert.deepEqual(cleanRewrite('<think>hm</think>', 'q'), { query: 'q', used: false })
  assert.deepEqual(cleanRewrite('x'.repeat(301), 'q'), { query: 'q', used: false })
})

test('rewriteTranscript keeps the last three exchanges, questions without excerpts, answers clipped, tool rounds skipped', () => {
  const prior = []
  for (let i = 1; i <= 4; i++) {
    prior.push({ role: 'user', content: `Document excerpts:\n\n[1] source: a.md\nchunk\n\nQuestion: Q${i}?` })
    if (i === 4) {
      prior.push({ role: 'assistant', content: '<tool_call>{"name":"lookup_stock"}</tool_call>' })
      prior.push({ role: 'tool', content: '{"matches":[]}\nNow answer the user in plain text from this result.' })
    }
    prior.push({ role: 'assistant', content: `A${i} ` + 'long '.repeat(100) })
  }
  const text = rewriteTranscript(prior, 'and the extended one?')
  assert.doesNotMatch(text, /Q1\?/)
  assert.match(text, /User: Q2\?\nAssistant: A2 long/)
  assert.match(text, /User: Q4\?\nAssistant: A4 long/)
  assert.doesNotMatch(text, /tool_call|Document excerpts/)
  assert.ok(text.endsWith('User: and the extended one?\n\nStandalone search query:'))
  // every answer is clipped to 300 characters
  for (const line of text.split('\n').filter((l) => l.startsWith('Assistant: '))) assert.ok(line.length <= 'Assistant: '.length + 300)
  assert.equal(rewriteTranscript([], 'first question'), null)
})

const excerptTurn = (question, chars = 20) => ({ role: 'user', content: `Document excerpts:\n\n[1] source: a.md\n${'x'.repeat(chars)}\n\nQuestion: ${question}` })

test('replayHistory strips the excerpts from earlier user turns under layout current only', () => {
  const stored = [
    excerptTurn('What is the P1 SLA?'),
    { role: 'assistant', content: 'Four hours.' },
    { role: 'user', content: 'And P2?' },
  ]
  assert.deepEqual(replayHistory(stored, 'current').map((m) => m.content), ['What is the P1 SLA?', 'Four hours.', 'And P2?'])
  assert.deepEqual(replayHistory(stored, 'all'), stored)
})

test('replayHistory keeps the excerpts of the turns from the base on, and every tool round', () => {
  const stored = [
    excerptTurn('Q1?'),
    { role: 'assistant', content: '<tool_call>{"name":"lookup_stock"}</tool_call>' },
    { role: 'tool', content: '{"matches":[]}\nNow answer the user in plain text from this result.' },
    { role: 'assistant', content: 'A1.' },
    excerptTurn('Q2?'),
    { role: 'assistant', content: 'A2.' },
  ]
  const replayed = replayHistory(stored, 'current', 4)
  assert.equal(replayed[0].content, 'Q1?')
  assert.ok(replayed[4].content.startsWith('Document excerpts:'))
  // the tool call and its result travel on whatever the base is
  assert.deepEqual(replayed.map((m) => m.role), stored.map((m) => m.role))
  assert.equal(replayed[2].content, stored[2].content)
})

test('compactionBase holds the cached base until the context crosses the budget', () => {
  const stored = [excerptTurn('Q1?', 400), { role: 'assistant', content: 'A1.' }]
  const opts = { layout: 'current', system: 'sys', k: 1 }
  // layout all never strips; without a budget only this turn keeps excerpts
  assert.equal(compactionBase(stored, 0, { ...opts, layout: 'all', budget: 4000 }), 0)
  assert.equal(compactionBase(stored, 0, { ...opts, budget: 0 }), stored.length)
  // under the budget the base stays put, so the cached prefix stays valid
  assert.equal(compactionBase(stored, 0, { ...opts, budget: 4000 }), 0)
  // over it the turn starts a clean prefix
  assert.equal(compactionBase(stored, 0, { ...opts, budget: 50 }), stored.length)
  // the room a turn's own excerpts need is reserved: k chunks at ~420 tokens
  assert.equal(compactionBase(stored, 0, { ...opts, k: 5, budget: 2200 }), stored.length)
  // a base past the end of the history is clamped, never negative work
  assert.equal(compactionBase(stored, 99, { ...opts, budget: 4000 }), stored.length)
})

test('estimateTokens counts the whole context and visibleChunks forgets the compacted turns', () => {
  assert.equal(estimateTokens([{ content: 'x'.repeat(320) }, { content: 'y'.repeat(320) }]), 200)
  const shown = [{ at: 0, ids: ['a.md::0'] }, { at: 4, ids: ['b.md::0', 'c.md::1'] }]
  assert.deepEqual(visibleChunks(shown, 0), ['a.md::0', 'b.md::0', 'c.md::1'])
  assert.deepEqual(visibleChunks(shown, 4), ['b.md::0', 'c.md::1'])
  assert.deepEqual(visibleChunks(shown, 5), [])
  // a session written before the positions were stored counts as shown
  assert.deepEqual(visibleChunks(['a.md::0'], 4), ['a.md::0'])
})

test('roundParams keeps our defaults under an empty ask and lets the caller override them', () => {
  // The regression this pins: the HTTP layer always passes a generationParams
  // object, empty when the request set neither temperature nor seed. It used
  // to be spread over the whole completion() call and replaced the defaults,
  // so neither temp nor predict ever reached the addon.
  assert.deepEqual(roundParams({}, { predict: 4096, discard: 0 }), { temp: 0.2, predict: 4096 })
  assert.deepEqual(roundParams(undefined, { predict: 320, discard: 0 }), { temp: 0.2, predict: 320 })
  assert.deepEqual(roundParams({ temp: 0, seed: 7 }, { predict: 4096, discard: 0 }), { temp: 0, predict: 4096, seed: 7 })
})

test('roundParams switches the reasoning compactor off while the sliding window is on', () => {
  // A slide that lands mid-generation invalidates the compactor's tracked
  // reasoning span and the addon fails the request outright, so the two
  // cannot both be on.
  assert.equal(roundParams({}, { predict: 4096, discard: 2048 }).remove_thinking_from_context, false)
  assert.equal('remove_thinking_from_context' in roundParams({}, { predict: 4096, discard: 0 }), false)
  // the caller still wins, in case a probe wants the compactor back
  assert.equal(roundParams({ remove_thinking_from_context: true }, { predict: 4096, discard: 2048 }).remove_thinking_from_context, true)
})
