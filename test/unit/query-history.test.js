import test from 'node:test'
import assert from 'node:assert/strict'
import { historyConfig, historyText, looksElliptical, queryTexts } from '../../src/rag/query-history.mjs'

const previous = ['What is the standard warranty on the ServoDrive X4?', 'And how long does the extended warranty run?', 'What is the RMA turnaround target?']

test('the defaults join the last two questions, and only for a follow-up', () => {
  // E2 of the 2026-09-21 grid: two beats three by a point at k=3 (84% against
  // 83%) and ties at k=5, and the gate is what matters -- joining every
  // question is worse than joining none.
  const cfg = historyConfig()
  assert.deepEqual([cfg.turns, cfg.when, cfg.mode], [2, 'elliptical', 'concat'])
  const joined = 'What is the RMA turnaround target? And P2?'
  assert.deepEqual(queryTexts('And P2?', previous, cfg), { vectorTexts: [joined], ftsTexts: [joined], joined })
  // a question that names its own subject searches for itself
  const standalone = 'What is the RMA turnaround target for a ServoDrive X4?'
  assert.deepEqual(queryTexts(standalone, previous, cfg), { vectorTexts: [standalone], ftsTexts: [standalone], joined: null })
})

test('turns counts the current question and takes the newest earlier ones, oldest first', () => {
  assert.equal(historyText('And P2?', previous, { turns: 3, chars: 600 }), 'And how long does the extended warranty run? What is the RMA turnaround target? And P2?')
  assert.equal(historyText('And P2?', previous, { turns: 3, chars: 600, order: 'newest' }), 'And P2? What is the RMA turnaround target? And how long does the extended warranty run?')
  assert.equal(historyText('And P2?', previous, { turns: 99, chars: 600 }).split(' ? ').length >= 1, true)
})

test('the character budget stops the walk and blanks and duplicates are skipped', () => {
  assert.equal(historyText('And P2?', previous, { turns: 99, chars: 50 }), 'What is the RMA turnaround target? And P2?')
  assert.equal(historyText('And P2?', ['', 'And P2?', 'Which depot?'], { turns: 99, chars: 600 }), 'Which depot? And P2?')
  assert.equal(historyText('And P2?', previous, { turns: 99, chars: 5 }), 'And P2?')
})

test('modes decide which leg sees the joined text', () => {
  const cfg = { turns: 2, chars: 600, order: 'oldest' }
  const joined = 'What is the RMA turnaround target? And P2?'
  assert.deepEqual(queryTexts('And P2?', previous, { ...cfg, mode: 'concat' }), { vectorTexts: [joined], ftsTexts: [joined], joined })
  assert.deepEqual(queryTexts('And P2?', previous, { ...cfg, mode: 'vector' }), { vectorTexts: [joined], ftsTexts: ['And P2?'], joined })
  assert.deepEqual(queryTexts('And P2?', previous, { ...cfg, mode: 'fts' }), { vectorTexts: ['And P2?'], ftsTexts: [joined], joined })
  assert.deepEqual(queryTexts('And P2?', previous, { ...cfg, mode: 'fuse' }), { vectorTexts: ['And P2?', joined], ftsTexts: ['And P2?', joined], joined })
  assert.deepEqual(queryTexts('First question?', [], { ...cfg, mode: 'fuse' }), { vectorTexts: ['First question?'], ftsTexts: ['First question?'], joined: null })
})

test('looksElliptical flags continuations, referents and very short questions', () => {
  for (const q of ['And P2?', 'So what was the Q2 revenue figure again?', 'What is the implementation services fee on that deal?', 'When is their EBR?', 'How much was APAC?', 'Remind me, how many months is the standard warranty?']) assert.equal(looksElliptical(q), true, q)
  for (const q of ['What was the June NPS?', 'Which accounts are on the CS watchlist?', 'How fast must L1 hand a P1 over to L2?', 'What is the maximum discount an Account Executive may give?']) assert.equal(looksElliptical(q), false, q)
})

test('QUERY_HISTORY_WHEN gates the history by the rules or by the case label', () => {
  const cfg = { turns: 2, chars: 600, order: 'oldest', mode: 'concat' }
  const alone = { vectorTexts: ['What was the June NPS?'], ftsTexts: ['What was the June NPS?'], joined: null }
  assert.deepEqual(queryTexts('What was the June NPS?', previous, { ...cfg, when: 'elliptical' }), alone)
  assert.equal(queryTexts('And P2?', previous, { ...cfg, when: 'elliptical' }).joined, 'What is the RMA turnaround target? And P2?')
  assert.deepEqual(queryTexts('What was the June NPS?', previous, { ...cfg, when: 'oracle' }, { followup: false }), alone)
  assert.equal(queryTexts('What was the June NPS?', previous, { ...cfg, when: 'oracle' }, { followup: true }).joined, 'What is the RMA turnaround target? What was the June NPS?')
})
