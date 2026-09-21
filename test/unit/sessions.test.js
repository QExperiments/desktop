import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessions, isSessionId } from '../../src/http/sessions.js'

let dir
before(async () => { dir = await mkdtemp(join(tmpdir(), 'sessions-')) })
after(() => rm(dir, { recursive: true, force: true }))

const turn = (query, answer, extra = {}) => ({ kind: 'text', query, answer, citations: [], ...extra })

test('append creates the session, keeps order and titles it by the first query', async () => {
  const sessions = createSessions(dir)
  await Promise.all([
    sessions.append('s1', { ...turn('P1 SLA?', '4 hours'), kind: 'text', citations: [{ file: 'a.txt' }] }),
    sessions.append('s1', { ...turn('And P2?', '8 hours'), kind: 'voice' }),
  ])
  const stored = await sessions.get('s1')
  assert.equal(stored.title, 'P1 SLA?')
  assert.deepEqual(stored.turns.map((t) => t.kind), ['text', 'voice'])
  assert.deepEqual(await sessions.history('s1'), [
    { role: 'user', content: 'P1 SLA?' }, { role: 'assistant', content: '4 hours' },
    { role: 'user', content: 'And P2?' }, { role: 'assistant', content: '8 hours' },
  ])
})

test('context replays the messages the model saw and the chunks it was shown', async () => {
  const sessions = createSessions(dir)
  const messages = [
    { role: 'user', content: 'Document excerpts:\n\n[1] source: a.txt\nMOQ 500\n\nQuestion: MOQ?' },
    { role: 'assistant', content: '<tool_call>{"name":"lookup_stock"}</tool_call>' },
    { role: 'tool', content: '{"matches":[]}' },
    { role: 'assistant', content: 'MOQ is 500.' },
  ]
  await sessions.append('s3', turn('MOQ?', 'MOQ is 500.', { messages, shown: ['a.txt::0'] }))
  await sessions.append('s3', turn('And lead time?', '6 weeks', { messages: [{ role: 'user', content: 'And lead time?' }, { role: 'assistant', content: '6 weeks' }], shown: [] }))
  const context = await sessions.context('s3')
  assert.deepEqual(context.shown, [{ at: 0, ids: ['a.txt::0'] }])
  assert.equal(context.base, 0)
  assert.equal(context.messages.length, 6)
  assert.deepEqual(context.messages.slice(0, 4), messages)
  assert.deepEqual(context.messages.at(-1), { role: 'assistant', content: '6 weeks' })
})

test('a turn stored before messages were kept replays as its question and answer', async () => {
  const sessions = createSessions(dir)
  await sessions.append('s4', { kind: 'text', question: 'Old?', answer: 'Yes', citations: [] })
  assert.deepEqual((await sessions.context('s4')).messages, [{ role: 'user', content: 'Old?' }, { role: 'assistant', content: 'Yes' }])
})

test('list is newest first with turn counts and no transcript', async () => {
  const sessions = createSessions(dir)
  await sessions.append('s2', turn('What is this?', 'A nameplate', { kind: 'image' }))
  const listed = await sessions.list()
  assert.deepEqual(listed.slice(0, 2).map((s) => [s.id, s.turns]), [['s2', 1], ['s4', 1]])
  assert.equal('turns' in listed[0] && Array.isArray(listed[0].turns), false)
})

test('ids outside the safe alphabet are ignored, never written', async () => {
  const sessions = createSessions(dir)
  assert.equal(await sessions.append('../etc/passwd', turn('x', 'y')), null)
  assert.equal(await sessions.get('../etc/passwd'), null)
  assert.deepEqual(await sessions.history('nope'), [])
  assert.deepEqual(await sessions.context('nope'), { messages: [], shown: [], base: 0 })
})

test('remove forgets a session and reports whether there was one', async () => {
  const sessions = createSessions(dir)
  await sessions.append('gone', turn('Q?', 'A'))
  assert.equal(await sessions.remove('gone'), true)
  assert.equal(await sessions.get('gone'), null)
  assert.equal(await sessions.remove('gone'), false)
  assert.equal(await sessions.remove('../etc/passwd'), false)
  assert.ok(!(await sessions.list()).some((s) => s.id === 'gone'))
})

test('isSessionId accepts the KV-cache alphabet only', () => {
  assert.equal(isSessionId('chat-abc.1_2'), true)
  assert.equal(isSessionId('x'.repeat(64)), true)
  assert.equal(isSessionId('x'.repeat(65)), false)
  assert.equal(isSessionId('a/b'), false)
  assert.equal(isSessionId(''), false)
  assert.equal(isSessionId(undefined), false)
})
