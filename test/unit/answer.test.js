import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXCERPT_TOKENS, cleanRewrite, compactionBase, compactionPlan, estimateTokens, rawQuery, replayHistory, rewriteTranscript, roundParams, systemPrompt, tailStart, visibleChunks, windowStart } from '../../src/chat/answer.js'

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
  // the room a turn's own excerpts need is reserved: k chunks at
  // EXCERPT_TOKENS, which follows the chunk size, so the budget here is
  // written against it rather than against the number of the day
  assert.equal(compactionBase(stored, 0, { ...opts, k: 5, budget: 5 * EXCERPT_TOKENS + 100 }), stored.length)
  assert.equal(compactionBase(stored, 0, { ...opts, k: 5, budget: 5 * EXCERPT_TOKENS + 4000 }), 0)
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
  const opts = { predict: 4096, discard: 0, reasoning: -1 }
  assert.deepEqual(roundParams({}, opts), { temp: 0.2, predict: 4096 })
  assert.deepEqual(roundParams(undefined, { ...opts, predict: 320 }), { temp: 0.2, predict: 320 })
  assert.deepEqual(roundParams({ temp: 0, seed: 7 }, opts), { temp: 0, predict: 4096, seed: 7 })
})

test('roundParams caps the reasoning channel unless the budget is negative', () => {
  // -1 is the addon's own "leave it open"; we send nothing rather than -1 so
  // a probe can tell our default apart from an explicit request.
  assert.equal(roundParams({}, { predict: 4096, discard: 0, reasoning: 512 }).reasoning_budget, 512)
  assert.equal(roundParams({}, { predict: 4096, discard: 0, reasoning: 0 }).reasoning_budget, 0)
  assert.equal('reasoning_budget' in roundParams({}, { predict: 4096, discard: 0, reasoning: -1 }), false)
  assert.equal(roundParams({ reasoning_budget: 2048 }, { predict: 4096, discard: 0, reasoning: 512 }).reasoning_budget, 2048)
})

test('roundParams switches the reasoning compactor off while the sliding window is on', () => {
  // A slide that lands mid-generation invalidates the compactor's tracked
  // reasoning span and the addon fails the request outright, so the two
  // cannot both be on.
  assert.equal(roundParams({}, { predict: 4096, discard: 2048, reasoning: -1 }).remove_thinking_from_context, false)
  assert.equal("remove_thinking_from_context" in roundParams({}, { predict: 4096, discard: 0, reasoning: -1 }), false)
  // the caller still wins, in case a probe wants the compactor back
  assert.equal(roundParams({ remove_thinking_from_context: true }, { predict: 4096, discard: 2048, reasoning: -1 }).remove_thinking_from_context, true)
})

test('windowStart holds until the budget is crossed, then keeps the last N exchanges', () => {
  const turns = (n) => Array.from({ length: n * 2 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(1000) }))
  const opts = { keep: 5, budget: 8000 }
  // off unless a window is asked for
  assert.equal(windowStart(turns(20), 0, { ...opts, keep: 0 }), 0)
  // under the budget the start holds, so the cached prefix stays valid
  assert.equal(windowStart(turns(8), 0, opts), 0)
  // over it, everything before the last five exchanges goes
  assert.equal(windowStart(turns(10), 0, opts), 10)
  assert.equal(windowStart(turns(12), 0, opts), 14)
  // a start already recorded holds while what follows it still fits
  assert.equal(windowStart(turns(11), 8, opts), 8)
  // and never moves backwards
  assert.equal(windowStart(turns(16), 8, opts), 22)
})

test('windowStart without a budget trims on turn count alone', () => {
  const turns = (n) => Array.from({ length: n * 2 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'short' }))
  assert.equal(windowStart(turns(4), 0, { keep: 5, budget: 0 }), 0)
  assert.equal(windowStart(turns(9), 0, { keep: 5, budget: 0 }), 8)
})

test('a compaction drops the tool rounds before it, and only those', () => {
  const history = [
    { role: 'user', content: 'Document excerpts:\n\n[1] source: a.md\nchunk\n\nQuestion: q1?' },
    { role: 'assistant', content: '<tool_call>{"name":"search_documents"}</tool_call>' },
    { role: 'tool', content: 'a big result' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2?' },
    { role: 'assistant', content: '<tool_call>{"name":"lookup_stock"}</tool_call>' },
    { role: 'tool', content: 'another big result' },
    { role: 'assistant', content: 'a2' },
  ]
  // nothing is dropped without the flag, and the excerpts still go
  assert.equal(replayHistory(history, 'current', history.length).length, 8)
  const reduced = replayHistory(history, 'current', history.length, { dropTools: true })
  assert.deepEqual(reduced.map((m) => m.role), ['user', 'assistant', 'user', 'assistant'])
  assert.equal(reduced[0].content, 'q1?')
  // rounds at or after the base are this turn's and stay whole
  const partial = replayHistory(history, 'current', 4, { dropTools: true })
  assert.deepEqual(partial.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'tool', 'assistant'])
})

test('tailStart keeps the last N messages and opens on a question', () => {
  const reduced = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' }))
  assert.equal(tailStart(reduced, 0), 0)
  assert.equal(tailStart(reduced, 20), 0)
  assert.equal(tailStart(reduced, 4), 4)
  // a cut that would land on an answer moves forward to the next question
  assert.equal(tailStart(reduced, 5), 4)
})

test('compactionPlan holds the replay until the budget is crossed, then compacts once', () => {
  const turn = (i) => [
    { role: 'user', content: `q${i}` },
    { role: 'assistant', content: '<tool_call>c</tool_call>' },
    { role: 'tool', content: 'x'.repeat(8600) },
    { role: 'assistant', content: 'a'.repeat(1300) },
  ]
  const history = (n) => Array.from({ length: n }, (_, i) => turn(i + 1)).flat()
  const opts = { layout: 'current', budget: 12000, keep: 10, dropTools: true, system: 's'.repeat(2000), k: 5 }
  let base = 0
  let from = 0
  const compactedAt = []
  for (let n = 1; n <= 9; n++) {
    const plan = compactionPlan(history(n), { ...opts, base, from })
    if (plan.compacted) compactedAt.push(n)
    base = plan.base
    from = plan.from
  }
  // periodically, not on every turn: how often depends on the excerpt
  // reserve, so assert the shape rather than the exact turns
  assert.ok(compactedAt.length >= 2 && compactedAt.length <= 4, `compacted at ${compactedAt}`)
  assert.ok(compactedAt.every((n, i) => i === 0 || n - compactedAt[i - 1] >= 3), `too often: ${compactedAt}`)
  // without dropping the tool rounds the same budget compacts on every turn,
  // which is what the tool-mode gap looked like
  base = 0
  from = 0
  const everyTurn = []
  for (let n = 1; n <= 9; n++) {
    const plan = compactionPlan(history(n), { ...opts, dropTools: false, base, from })
    if (plan.compacted) everyTurn.push(n)
    base = plan.base
    from = plan.from
  }
  // the contrast that matters: without dropping the tool rounds the same
  // budget compacts on consecutive turns, not every third one
  assert.ok(everyTurn.length > compactedAt.length, `dropTools should compact less often: ${everyTurn} vs ${compactedAt}`)
  const gap = (list) => Math.min(...list.slice(1).map((n, i) => n - list[i]))
  assert.ok(gap(everyTurn) < gap(compactedAt), `dropTools should stretch the gap: ${everyTurn} vs ${compactedAt}`)
})
