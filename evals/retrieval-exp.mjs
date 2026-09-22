#!/usr/bin/env node
// `node evals/retrieval-exp.mjs`: the retrieval experiment of docs/todo-3-exp.md.
// Runs every variant of evals/exp/retrieval-variants.json in its own process
// (evals/lib/retrieval-exp-worker.mjs) with the variant's env over the
// production defaults and its own LanceDB directory under data/lancedb-exp/,
// then builds compare.md and compare.html in the results directory. No LLM.
//
//   --only B0,C1,F3      run these variants only
//   --out <dir>          results directory (default evals/results/retrieval-exp-<ts>)
//   --reingest           rebuild the LanceDB directory of each variant
//   --best               after the grid: compose BEST from the per-axis winners and run it
//   --report-only <dir>  rebuild compare.md/html from an existing directory
//   --variants <file>    another variants file
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildRetrievalExpReport, pickBest } from './lib/report/retrieval-exp.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { values: flags } = parseArgs({ options: {
  only: { type: 'string' }, out: { type: 'string' }, reingest: { type: 'boolean', default: false }, best: { type: 'boolean', default: false },
  'report-only': { type: 'string' }, variants: { type: 'string' }, cases: { type: 'string' },
} })

if (flags['report-only']) {
  const dir = resolve(flags['report-only'])
  const written = await buildRetrievalExpReport(dir)
  console.log(`report: ${written.join(', ')}`)
  process.exit(0)
}

const variantsFile = resolve(flags.variants ?? join(here, 'exp', 'retrieval-variants.json'))
const all = Object.fromEntries(Object.entries(JSON.parse(await readFile(variantsFile, 'utf8'))).filter(([name]) => !name.startsWith('_')))
const names = flags.only ? flags.only.split(',').map((s) => s.trim()).filter(Boolean) : Object.keys(all)
for (const name of names) if (!all[name]) { console.error(`unknown variant ${name}; known: ${Object.keys(all).join(', ')}`); process.exit(2) }

const out = resolve(flags.out ?? join(here, 'results', `retrieval-exp-${new Date().toISOString().replace(/[:.]/g, '-')}`))
await mkdir(out, { recursive: true })
// One index tree per variants file: a variant named like one of another grid
// (E2 here and in retrieval-variants.json) must not inherit its index.
const expRoot = join(here, '..', 'data', 'lancedb-exp', basename(variantsFile, '.json'))

const runVariant = (name, spec) => new Promise((done, fail) => {
  // B0 pins the pre-ADR-013 defaults; every variant is one change on top of it.
  const env = { ...process.env, ...(all.B0?.env ?? {}), ...spec.env, LANCE_DB_DIR: join(expRoot, name) }
  const args = [join(here, 'lib', 'retrieval-exp-worker.mjs'), '--variant', name, '--out', out]
  if (flags.reingest) args.push('--reingest')
  if (flags.cases) args.push('--cases', flags.cases)
  const started = Date.now()
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = ''
  const keep = (chunk) => { tail = (tail + chunk.toString()).split('\n').filter((l) => l.trim() && !l.includes('Downloading')).slice(-12).join('\n') }
  child.stdout.on('data', keep)
  child.stderr.on('data', (chunk) => { keep(chunk); for (const line of chunk.toString().split('\n')) if (line.startsWith(`[${name}]`)) console.log(line) })
  child.on('error', fail)
  child.on('close', (code) => {
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    if (code === 0) return done({ name, ok: true, seconds })
    console.error(`${name}: worker exited with ${code} after ${seconds}s\n${tail}`)
    done({ name, ok: false, seconds, code, tail })
  })
})

// A second call with --only into the same directory adds to the earlier variants.
const previous = JSON.parse(await readFile(join(out, 'variants.json'), 'utf8').catch(() => 'null'))
const spec = { variantsFile, out, started_at: previous?.started_at ?? new Date().toISOString(), variants: previous?.variants ?? {}, failures: previous?.failures ?? {} }
for (const name of names) {
  console.log(`\n=== ${name}: ${all[name].change}`)
  const result = await runVariant(name, all[name])
  spec.variants[name] = { ...all[name], seconds: Number(result.seconds), ok: result.ok }
  if (result.ok) delete spec.failures[name]
  else spec.failures[name] = { code: result.code, tail: result.tail }
  await writeFile(join(out, 'variants.json'), `${JSON.stringify(spec, null, 2)}\n`)
}

if (flags.best) {
  const best = await pickBest(out, all)
  if (best) {
    console.log(`\n=== BEST: ${best.change}`)
    all.BEST = best
    const result = await runVariant('BEST', best)
    spec.variants.BEST = { ...best, seconds: Number(result.seconds), ok: result.ok }
    if (!result.ok) spec.failures.BEST = { code: result.code, tail: result.tail }
    await writeFile(join(out, 'variants.json'), `${JSON.stringify(spec, null, 2)}\n`)
  } else {
    console.log('\nBEST: no variant beat B0 on recall@3, nothing to compose')
  }
}

const written = await buildRetrievalExpReport(out)
console.log(`\nreport: ${written.join(', ')}`)
