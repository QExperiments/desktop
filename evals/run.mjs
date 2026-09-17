#!/usr/bin/env node
// `npm run eval`: cases → live serve → traces → metrics → judge → report.
// Phases in order (see docs/todo.md "Flow"):
//   retrieval in-process (no serve) → sampler before_load → serve start →
//   loaded_idle → every live case × run × turn (generating) → after_generation
//   → serve stop → after_unload → judge → metrics.json → report.html
import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { aggregate } from './lib/aggregate.mjs'
import { CATEGORIES, LIVE, countTurns, loadCases } from './lib/cases.mjs'
import { ask } from './lib/client.mjs'
import { judge } from './lib/judge/judge.mjs'
import { scoreMemory } from './lib/metrics/memory.mjs'
import { scoreRetrieval } from './lib/metrics/retrieval.mjs'
import { scoreText } from './lib/metrics/text.mjs'
import { scoreTools } from './lib/metrics/tools.mjs'
import { buildReport } from './lib/report/build.mjs'
import { createSampler } from './lib/sampler.mjs'
import { startServer } from './lib/server.mjs'
import { contextOf, copyTraces, readTrace } from './lib/traces.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

const { values: flags } = parseArgs({
  options: {
    tier: { type: 'string' },
    only: { type: 'string' },
    runs: { type: 'string' },
    'no-judge': { type: 'boolean', default: false },
    judge: { type: 'string' },
    'report-only': { type: 'string' },
    'judge-only': { type: 'string' },
    cases: { type: 'string' },
    config: { type: 'string', default: join(here, 'config.json') },
  },
})

const config = JSON.parse(await readFile(flags.config, 'utf8'))
const log = (fields, msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}${fields ? ' ' + JSON.stringify(fields) : ''}`)
const jsonl = (path) => (row) => appendFile(path, `${JSON.stringify(row)}\n`)
const readJsonl = async (path) => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

// --report-only <dir>: recompute metrics.json and the report from stored rows.
if (flags['report-only']) {
  const dir = resolve(flags['report-only'])
  const turns = await readJsonl(join(dir, 'turns.jsonl'))
  const verdicts = await readJsonl(join(dir, 'verdicts.jsonl'))
  const hardware = await readJsonl(join(dir, 'hardware.jsonl'))
  const header = JSON.parse(await readFile(join(dir, 'header.json'), 'utf8'))
  const cases = await loadCases({ dir: flags.cases ?? join(here, 'cases'), runs: header.runs })
  const metrics = await aggregate({ turns, verdicts, hardware, cases, config, labelsDir: join(here, 'cases', 'labels'), header })
  await writeFile(join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2))
  const out = await buildReport(dir)
  log(out, 'report rebuilt')
  process.exit(0)
}

// --judge-only <dir>: keep the turns of a finished run, grade them again
// (a new judge model, a changed prompt) and rebuild the report.
const judgeOnly = flags['judge-only'] ? resolve(flags['judge-only']) : null
const stored = judgeOnly ? JSON.parse(await readFile(join(judgeOnly, 'header.json'), 'utf8')) : null

const tier = (flags.tier ?? stored?.tier ?? config.tier).toUpperCase()
const runs = Number(flags.runs ?? stored?.runs ?? config.runs)
const only = flags.only ? flags.only.split(',').map((s) => s.trim()) : CATEGORIES
const casesDir = flags.cases ?? join(here, 'cases')
const ts = stored?.ts ?? new Date().toISOString().replace(/[:.]/g, '-')
const runTag = `eval-${ts}`
const out = judgeOnly ?? join(here, 'results', ts)
await mkdir(out, { recursive: true })
const writeTurn = jsonl(join(out, 'turns.jsonl'))
const writeVerdict = jsonl(join(out, 'verdicts.jsonl'))
await writeFile(join(out, 'verdicts.jsonl'), '')

const plan = await loadCases({ dir: casesDir, only, runs })
if (!judgeOnly) log({ tier, runs, categories: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length])), turns: countTurns(plan), out }, 'plan')

// ---- retrieval: no model call, its own embedder, released before the sampler starts
if (plan.retrieval?.length && !judgeOnly) {
  const { releaseModel, search } = await import('../src/rag/retrieve.mjs')
  for (const job of plan.retrieval) {
    const k = job.case.k ?? 3
    const t0 = Date.now()
    const results = await search(job.case.query, k)
    const retrieval_ms = Date.now() - t0
    const files = results.map((r) => r.file)
    await writeTurn({ category: 'retrieval', id: job.case.id, run: 1, turn: 1, query: job.case.query, gold: job.case.gold_doc_ids, retrieval_ms, ...scoreRetrieval(files, job.case.gold_doc_ids, k) })
  }
  await releaseModel()
  log({ n: plan.retrieval.length }, 'retrieval scored')
}

// ---- live categories against a fresh serve
const liveJobs = judgeOnly ? [] : Object.entries(plan).filter(([category]) => category !== 'retrieval').flatMap(([, jobs]) => jobs)
let header = stored ?? { ts, tier, runs, config, judge: flags['no-judge'] ? null : (flags.judge ?? config.judge.constant) }
if (judgeOnly) header = { ...header, judge: flags.judge ?? config.judge.constant }
if (liveJobs.length) {
  const sampler = createSampler({ intervalMs: config.sampleMs, out: join(out, 'hardware.jsonl') })
  sampler.mark({ phase: 'before_load' })
  await sampler.start()
  await sleep(3000)

  const server = await startServer({ port: config.port, tier, cwd: repo, logPath: join(out, 'serve.log') })
  sampler.watch(server.pid)
  sampler.mark({ phase: 'loaded_idle' })
  const health = await server.health()
  header = { ...header, coldStartMs: server.coldStartMs, hardware: health.hardware, chatModel: health.models?.find((m) => m.role === 'chat')?.constant, embedModel: health.models?.find((m) => m.role === 'embed')?.constant, servedTier: health.tier }
  log({ coldStartMs: server.coldStartMs, tier: health.tier, chat: header.chatModel }, 'serve ready')
  await sleep(4000)

  const tracesDir = join(repo, 'data', 'traces')
  let done = 0
  const total = countTurns(plan)
  try {
    for (const job of liveJobs) {
      const { category } = job
      const session = LIVE.has(category) ? `${runTag}-${job.case.id}-r${job.run}`.slice(0, 64) : null
      const rows = []
      for (const turn of job.turns) {
        sampler.mark({ phase: 'generating', category, case: job.case.id, run: job.run, turn: turn.turn })
        const messages = category === 'tools' ? [...turn.history, { role: 'user', content: turn.query }] : [{ role: 'user', content: turn.query }]
        const reply = await ask({ base: server.base, messages, session, run: runTag, timeoutMs: config.requestTimeoutMs })
        const trace = await readTrace(tracesDir, runTag, reply.requestId)
        const { excerpts, toolResults, hits } = contextOf(trace)
        const context = `${excerpts}\n${toolResults}`
        const gold = turn.gold_doc_ids ?? job.case.gold_doc_ids ?? []
        const text = scoreText({ query: turn.query, text: reply.text, citations: reply.citations, gold, reference: turn.reference ?? job.case.reference, mustPatterns: turn.must ?? [], context })
        const tools = scoreTools(trace, { tool: turn.tool ?? null, args: turn.args ?? null })
        const row = {
          category, id: job.case.id, run: job.run, turn: turn.turn, session, query: turn.query, kind: job.case.kind, note: job.case.note, followup: turn.followup === true,
          reference: turn.reference ?? job.case.reference ?? null, expected_tool: turn.tool === undefined ? undefined : (turn.tool ?? null), expected_args: turn.args ?? null,
          status: reply.status, error: reply.error, text: reply.text, citations: reply.citations, requestId: reply.requestId,
          wall_ms: reply.wallMs, ttft_client_ms: reply.ttftClientMs, usage: reply.usage, stats: reply.stats ? { ...reply.stats, tool_calls: undefined } : null,
          hits: hits.map(({ content, ...hit }) => hit), context: excerpts, toolResults, rounds: trace?.rounds?.length ?? null,
          thinking_chars: (trace?.rounds ?? []).reduce((s, r) => s + (r.thinkingChars ?? 0), 0),
          tool_calls: (trace?.rounds ?? []).flatMap((r) => r.toolCalls ?? []),
          ...text, ...tools,
        }
        rows.push(row)
        await writeTurn(row)
        done++
        if (reply.error) log({ id: job.case.id, run: job.run, turn: turn.turn, status: reply.status, error: reply.error }, 'turn failed')
        else log({ id: job.case.id, run: job.run, turn: turn.turn, ms: reply.wallMs, must: row.must, tools: tools.called.join('+') || '-', done: `${done}/${total}` }, 'turn')
      }
      sampler.mark({ phase: 'after_generation', category, case: job.case.id, run: job.run })
      if (category === 'memory') log({ id: job.case.id, run: job.run, memory: scoreMemory(rows, job.case).memory_at_d }, 'memory case')
    }
  } finally {
    sampler.mark({ phase: 'after_generation' })
    await sleep(2000)
    await server.stop()
    sampler.mark({ phase: 'after_unload' })
    await sleep(4000)
    await sampler.stop()
    await copyTraces(tracesDir, runTag, join(out, 'traces'))
  }
  log({ turns: done }, 'serve stopped')
}
await writeFile(join(out, 'header.json'), JSON.stringify(header, null, 2))

// ---- judge, after serve is gone so its memory never overlaps the phases above
const turns = await readJsonl(join(out, 'turns.jsonl'))
let verdicts = []
if (!flags['no-judge']) {
  const judgeConfig = { ...config.judge, ...(flags.judge ? { constant: flags.judge } : {}) }
  const categories = config.judgeCategories ?? ['single']
  const units = []
  for (const category of categories) {
    const rows = turns.filter((t) => t.category === category && !t.error)
    if (category === 'multiturn') {
      const groups = {}
      for (const row of rows) (groups[`${row.id}#${row.run}`] ??= []).push(row)
      for (const [key, group] of Object.entries(groups)) units.push({ key: `multiturn-${key}`, category, rows: group })
    } else {
      for (const row of rows) units.push({ key: `${category}-${row.id}-r${row.run}-t${row.turn}`, category, rows: [row] })
    }
  }
  if (units.length) {
    log({ judge: judgeConfig.constant, units: units.length, batch: judgeConfig.batch }, 'judge starting')
    const t0 = Date.now()
    verdicts = await judge({ units, config: judgeConfig, log: { info: (f, m) => log(f, m), warn: (f, m) => log(f, m) }, onVerdict: writeVerdict })
    log({ verdicts: verdicts.length, ms: Date.now() - t0 }, 'judge done')
  }
}

const hardware = await readJsonl(join(out, 'hardware.jsonl'))
const metrics = await aggregate({ turns, verdicts, hardware, cases: plan, config, labelsDir: join(here, 'cases', 'labels'), header })
await writeFile(join(out, 'metrics.json'), JSON.stringify(metrics, null, 2))
const report = await buildReport(out)
log(report, 'done')
console.log(`\nreport: ${report.html}`)
