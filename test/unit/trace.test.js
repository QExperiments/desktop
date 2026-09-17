import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createTraces } from '../../src/http/trace.js'

let dir
before(async () => { dir = await mkdtemp(join(tmpdir(), 'traces-')) })
after(() => rm(dir, { recursive: true, force: true }))

test('writes one JSON file per request under the run directory', async () => {
  const traces = createTraces(dir)
  const path = await traces.write('2026-09-18T10-00', 'chatcmpl-1', { query: 'q', rounds: [] })
  assert.equal(path, join(dir, '2026-09-18T10-00', 'chatcmpl-1.json'))
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { query: 'q', rounds: [] })
})

test('refuses run names and ids that could leave the traces directory', async () => {
  const traces = createTraces(dir)
  assert.equal(await traces.write('../outside', 'chatcmpl-1', {}), null)
  assert.equal(await traces.write('run', 'a/b', {}), null)
})
