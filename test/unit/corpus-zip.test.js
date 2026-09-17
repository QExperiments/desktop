import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { unpackCorpus } from '../../src/rag/corpus-zip.js'

const run = promisify(execFile)
const hasZip = await run('zip', ['-v']).then(() => true, () => false)

let dir
before(async () => { dir = await mkdtemp(join(tmpdir(), 'corpus-zip-')) })
after(() => rm(dir, { recursive: true, force: true }))

test('unpacks corpus.zip into data/ and leaves an existing corpus alone', { skip: hasZip ? false : 'zip CLI not installed' }, async () => {
  const src = join(dir, 'src', 'corpus', 'policies')
  await mkdir(src, { recursive: true })
  await writeFile(join(src, 'a.md'), 'MOQ 500')
  const zipPath = join(dir, 'corpus.zip')
  await run('zip', ['-r', '-q', zipPath, 'corpus'], { cwd: join(dir, 'src') })

  const dataDir = join(dir, 'data')
  const corpusDir = join(dataDir, 'corpus')
  const first = await unpackCorpus({ corpusDir, zipPath, dataDir })
  assert.equal(first.unpacked, true)
  assert.equal(await readFile(join(corpusDir, 'policies', 'a.md'), 'utf8'), 'MOQ 500')

  await writeFile(join(corpusDir, 'policies', 'a.md'), 'edited by hand')
  const second = await unpackCorpus({ corpusDir, zipPath, dataDir })
  assert.equal(second.unpacked, false)
  assert.equal(await readFile(join(corpusDir, 'policies', 'a.md'), 'utf8'), 'edited by hand')
})

test('reports a missing zip instead of throwing', async () => {
  const result = await unpackCorpus({ corpusDir: join(dir, 'nope', 'corpus'), zipPath: join(dir, 'missing.zip'), dataDir: join(dir, 'nope') })
  assert.equal(result.unpacked, false)
  assert.equal(existsSync(join(dir, 'nope', 'corpus')), false)
})
