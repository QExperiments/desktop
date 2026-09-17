import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessions } from '../../src/http/sessions.js'

let dir
before(async () => { dir = await mkdtemp(join(tmpdir(), 'sessions-')) })
after(() => rm(dir, { recursive: true, force: true }))

test('append creates the session, keeps order and titles it by the first question', async () => {
  const sessions = createSessions(dir)
  await Promise.all([
    sessions.append('s1', { kind: 'text', question: 'P1 SLA?', answer: '4 hours', citations: [{ file: 'a.txt' }] }),
    sessions.append('s1', { kind: 'voice', question: 'And P2?', answer: '8 hours', citations: [] }),
  ])
  const stored = await sessions.get('s1')
  assert.equal(stored.title, 'P1 SLA?')
  assert.deepEqual(stored.turns.map((turn) => turn.kind), ['text', 'voice'])
  assert.deepEqual(await sessions.history('s1'), [
    { role: 'user', content: 'P1 SLA?' }, { role: 'assistant', content: '4 hours' },
    { role: 'user', content: 'And P2?' }, { role: 'assistant', content: '8 hours' },
  ])
})

test('list is newest first with turn counts and no transcript', async () => {
  const sessions = createSessions(dir)
  await sessions.append('s2', { kind: 'image', question: 'What is this?', answer: 'A nameplate', citations: [] })
  const listed = await sessions.list()
  assert.deepEqual(listed.map((s) => [s.id, s.turns]), [['s2', 1], ['s1', 2]])
  assert.equal('turns' in listed[0] && Array.isArray(listed[0].turns), false)
})

test('ids outside the safe alphabet are ignored, never written', async () => {
  const sessions = createSessions(dir)
  assert.equal(await sessions.append('../etc/passwd', { question: 'x', answer: 'y' }), null)
  assert.equal(await sessions.get('../etc/passwd'), null)
  assert.deepEqual(await sessions.history('nope'), [])
})
