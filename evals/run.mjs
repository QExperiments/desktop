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
import { fitContext, judge } from './lib/judge/judge.mjs'
import { scoreMemory } from './lib/metrics/memory.mjs'
import { scoreRetrievalTurn } from './lib/metrics/retrieval-turn.mjs'
import { K_LIST, scoreRetrieval } from './lib/metrics/retrieval.mjs'
import { citationRecall, scoreText } from './lib/metrics/text.mjs'
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
    // local (default) or claude-cli. Only the flag selects claude-cli: its
    // prompts, corpus excerpts included, go to Anthropic (lib/judge/judge.mjs).
    'judge-backend': { type: 'string', default: 'local' },
    'report-only': { type: 'string' },
    'judge-only': { type: 'string' },
    'retrieval-only': { type: 'string' },
    // A retrieval strategy from config.json `variants` (ADR-012): serve starts
    // with that environment and the results directory carries the name.
    variant: { type: 'string' },
    cases: { type: 'string' },
    config: { type: 'string', default: join(here, 'config.json') },
  },
})

const config = JSON.parse(await readFile(flags.config, 'utf8'))
const judgeBackend = flags['judge-backend']
if (!['local', 'claude-cli'].includes(judgeBackend)) throw new Error(`--judge-backend must be local or claude-cli, not ${judgeBackend}`)
if (config.judge?.backend && config.judge.backend !== 'local') throw new Error('judge.backend in config.json must stay "local"; pass --judge-backend claude-cli on the command line to send judge prompts to Anthropic')
const log = (fields, msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}${fields ? ' ' + JSON.stringify(fields) : ''}`)
const jsonl = (path) => (row) => appendFile(path, `${JSON.stringify(row)}\n`)
const readJsonl = async (path) => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

// A stored row already holds the calls the turn made, the chunks it was
// shown and the tool the case wanted, so routing can be scored again without
// the traces. That is what carries a changed metric back to finished runs.
// Retrieval, scored again over a finished run. The rows carry the hits and
// the gold, so the only thing to rebuild is what had been shown earlier in
// the session and was still in the context: walk each session in order and
// clear the set wherever a turn reported a compaction.
const rescoreRetrieval = (rows) => {
  const shown = new Map()
  return rows.map((row) => {
    if (!LIVE.has(row.category)) return row
    const key = `${row.category}#${row.id}#${row.run}`
    if (row.turn === 1 || row.compacted) shown.set(key, new Set())
    const before = shown.get(key) ?? new Set()
    const scored = scoreRetrievalTurn({ hits: row.hits ?? [], gold: row.gold ?? [], shownBefore: before })
    scored.citation_recall = citationRecall(row.citations, row.gold ?? [])
    for (const hit of row.hits ?? []) before.add(hit.file)
    shown.set(key, before)
    return { ...row, ...scored }
  })
}

const rescoreTools = (row) => {
  if (!('expected_tool' in row)) return row
  const scored = scoreTools({ rounds: [{ toolCalls: row.tool_calls ?? [] }] }, { tool: row.expected_tool, args: row.expected_args ?? null }, { hits: row.hits ?? [] })
  const { rounds, repeat_calls, limit_hits, tool_errors, tool_ms, ...routing } = scored
  return { ...row, ...routing }
}

// --report-only <dir>: recompute metrics.json and the report from stored rows.
if (flags['report-only']) {
  const dir = resolve(flags['report-only'])
  const turns = rescoreRetrieval((await readJsonl(join(dir, 'turns.jsonl'))).map(rescoreTools))
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
// --retrieval-only <dir>: keep the live turns and the verdicts of a finished
// run, score retrieval again (new cases, a changed metric, a re-ingested
// index) and rebuild the report. Retrieval never calls the chat model, so the
// stored latency and hardware rows stay valid.
const judgeOnly = flags['judge-only'] ? resolve(flags['judge-only']) : null
const retrievalOnly = flags['retrieval-only'] ? resolve(flags['retrieval-only']) : null
const storedDir = judgeOnly ?? retrievalOnly
const stored = storedDir ? JSON.parse(await readFile(join(storedDir, 'header.json'), 'utf8')) : null

const variant = flags.variant ?? stored?.variant ?? null
if (variant && !config.variants?.[variant]) throw new Error(`--variant must be one of ${Object.keys(config.variants ?? {}).join(', ')}, not ${variant}`)
const serverEnv = variant ? config.variants[variant].env ?? {} : {}
const tier = (flags.tier ?? stored?.tier ?? config.tier).toUpperCase()
const runs = Number(flags.runs ?? stored?.runs ?? config.runs)
const only = flags.only ? flags.only.split(',').map((s) => s.trim()) : CATEGORIES
const casesDir = flags.cases ?? join(here, 'cases')
const ts = stored?.ts ?? new Date().toISOString().replace(/[:.]/g, '-')
const runTag = `eval-${ts}`
const out = storedDir ?? join(here, 'results', variant ? `${ts}-${variant}` : ts)
await mkdir(out, { recursive: true })
const writeTurn = jsonl(join(out, 'turns.jsonl'))
const writeVerdict = jsonl(join(out, 'verdicts.jsonl'))
if (!retrievalOnly) await writeFile(join(out, 'verdicts.jsonl'), '')

const plan = await loadCases({ dir: casesDir, only, runs })
if (!storedDir) log({ tier, runs, categories: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length])), turns: countTurns(plan), out }, 'plan')

// ---- retrieval: no model call, its own embedder, released before the sampler
// starts. One search per k in K_LIST, each scored at its own depth (see
// lib/metrics/retrieval.mjs for why a deep search sliced would not do).
if (plan.retrieval?.length && !judgeOnly) {
  const { releaseModel, search } = await import('../src/rag/retrieve.mjs')
  const rows = []
  const deepestK = Math.max(...K_LIST)
  for (const job of plan.retrieval) {
    const perK = {}
    let hits = []
    let retrieval_ms = null
    for (const k of K_LIST) {
      const t0 = Date.now()
      const results = await search(job.case.query, k)
      perK[k] = results.map((r) => r.file)
      if (k === deepestK) {
        retrieval_ms = Date.now() - t0
        hits = results.map((r) => ({ file: r.file, chunkIndex: r.chunkIndex, score: r.score }))
      }
    }
    rows.push({ category: 'retrieval', id: job.case.id, run: 1, turn: 1, query: job.case.query, gold: job.case.gold_doc_ids, retrieval_ms, hits, ...scoreRetrieval(perK, job.case.gold_doc_ids) })
  }
  await releaseModel()
  if (retrievalOnly) {
    // Replace the run's retrieval rows; every live turn stays as it was.
    const kept = (await readJsonl(join(out, 'turns.jsonl'))).filter((row) => row.category !== 'retrieval')
    await writeFile(join(out, 'turns.jsonl'), [...rows, ...kept].map((row) => `${JSON.stringify(row)}\n`).join(''))
  } else {
    for (const row of rows) await writeTurn(row)
  }
  log({ n: plan.retrieval.length }, 'retrieval scored')
}

// ---- live categories against a fresh serve
const liveJobs = storedDir ? [] : Object.entries(plan).filter(([category]) => category !== 'retrieval').flatMap(([, jobs]) => jobs)
const judgeName = flags['no-judge'] ? null : judgeBackend === 'claude-cli' ? `claude-cli:${config.judge.cliModel ?? 'haiku'}` : (flags.judge ?? config.judge.constant)
let header = stored ?? { ts, tier, runs, variant, serverEnv, config, judge: judgeName, judgeBackend }
if (judgeOnly) header = { ...header, judge: judgeName, judgeBackend }
if (liveJobs.length) {
  const sampler = createSampler({ intervalMs: config.sampleMs, out: join(out, 'hardware.jsonl') })
  sampler.mark({ phase: 'before_load' })
  await sampler.start()
  await sleep(3000)

  const server = await startServer({ port: config.port, tier, cwd: repo, logPath: join(out, 'serve.log'), env: serverEnv })
  sampler.watch(server.pid)
  sampler.mark({ phase: 'loaded_idle' })
  const health = await server.health()
  header = { ...header, coldStartMs: server.coldStartMs, hardware: health.hardware, chatModel: health.models?.find((m) => m.role === 'chat')?.constant, embedModel: health.models?.find((m) => m.role === 'embed')?.constant, servedTier: health.tier }
  log({ coldStartMs: server.coldStartMs, tier: health.tier, chat: header.chatModel, variant: variant ?? 'baseline', env: serverEnv }, 'serve ready')
  await sleep(4000)

  const tracesDir = join(repo, 'data', 'traces')
  let done = 0
  const total = countTurns(plan)
  try {
    for (const job of liveJobs) {
      const { category } = job
      const session = LIVE.has(category) ? `${runTag}-${job.case.id}-r${job.run}`.slice(0, 64) : null
      const rows = []
      // Rows whose excerpts are still in the model's context. A turn that
      // reports a compaction (layout current) replaced the context with a
      // clean one, so everything before it is gone; under layout all the
      // list is every row of the session.
      let inContext = []
      for (const turn of job.turns) {
        sampler.mark({ phase: 'generating', category, case: job.case.id, run: job.run, turn: turn.turn })
        const messages = category === 'tools' ? [...turn.history, { role: 'user', content: turn.query }] : [{ role: 'user', content: turn.query }]
        const reply = await ask({ base: server.base, messages, session, run: runTag, timeoutMs: config.requestTimeoutMs })
        const trace = await readTrace(tracesDir, runTag, reply.requestId)
        const { excerpts, toolResults, hits } = contextOf(trace)
        // An answer may draw on excerpts shown earlier in the session, so
        // `grounded` checks the numbers against everything shown so far, not
        // only this turn. Scored per turn it called 44 turns of the
        // 2026-09-21 run ungrounded, 16 of them turns that brought no
        // excerpts at all; session-wide clears 48 of 59. On a single-turn
        // case `rows` is empty and this is the turn's own context.
        const context = [...rows.map((r) => `${r.context}\n${r.toolResults}`), `${excerpts}\n${toolResults}`].join('\n')
        const gold = turn.gold_doc_ids ?? job.case.gold_doc_ids ?? []
        // Retrieval is scored from the hits the model saw, with the files shown
        // earlier in the session. Every live category is scored the same way,
        // so `agent` and `multiquery` recall are the same measurement and the
        // two retrieval designs can be put side by side.
        if (trace?.retrieval?.compacted) inContext = []
        const shownBefore = new Set(inContext.flatMap((r) => (r.hits ?? []).map((h) => h.file)))
        const retrieval = LIVE.has(category) ? scoreRetrievalTurn({ hits, gold, shownBefore }) : {}
        const text = scoreText({ query: turn.query, text: reply.text, citations: reply.citations, gold, reference: turn.reference ?? job.case.reference, mustPatterns: turn.must ?? [], context })
        const tools = scoreTools(trace, { tool: turn.tool ?? null, args: turn.args ?? null }, { hits })
        const row = {
          category, id: job.case.id, run: job.run, turn: turn.turn, session, query: turn.query, kind: job.case.kind, note: job.case.note, followup: turn.followup === true,
          reference: turn.reference ?? job.case.reference ?? null, gold, expected_tool: turn.tool === undefined ? undefined : (turn.tool ?? null), expected_args: turn.args ?? null,
          status: reply.status, error: reply.error, text: reply.text, citations: reply.citations, requestId: reply.requestId,
          wall_ms: reply.wallMs, ttft_client_ms: reply.ttftClientMs, usage: reply.usage, stats: reply.stats ? { ...reply.stats, tool_calls: undefined } : null,
          hits: hits.map(({ content, ...hit }) => hit), context: excerpts, toolResults, rounds: trace?.rounds?.length ?? null,
          thinking_chars: (trace?.rounds ?? []).reduce((s, r) => s + (r.thinkingChars ?? 0), 0),
          // The live KV a round ended with; `cacheTokens` already holds that
          // round's prompt and answer, so it is the context, not an addend
          // (src/chat/stats.js).
          context_tokens: (trace?.rounds ?? []).reduce((max, r) => Math.max(max, (r.stats?.cacheTokens ?? 0) || ((r.stats?.promptTokens ?? 0) + (r.stats?.generatedTokens ?? 0))), 0) || null,
          // KV cache the turn started from: what stood in it before the first
          // round ran, which is that round's final size less its own tokens.
          cached_tokens: trace?.rounds?.[0]?.stats
            ? Math.max(0, (trace.rounds[0].stats.cacheTokens ?? 0) - (trace.rounds[0].stats.promptTokens ?? 0) - (trace.rounds[0].stats.generatedTokens ?? 0))
            : null,
          tool_calls: (trace?.rounds ?? []).flatMap((r) => r.toolCalls ?? []),
          // Retrieval strategy fields (ADR-012): the mode serve ran, how many
          // chunks this turn put in front of the model for the first time, the
          // search_documents calls it made and the rewrite it searched for.
          retrieval_mode: trace?.retrieval?.mode ?? null,
          fusion: trace?.retrieval?.fusion ?? null,
          layout: trace?.retrieval?.layout ?? null,
          engine: trace?.retrieval?.engine ?? null,
          // The chat role's sliding window, when an experiment turned it on:
          // ctx_size it was given and how many tokens a discard drops.
          ctx: trace?.retrieval?.ctx ?? null,
          discard: trace?.retrieval?.discard ?? null,
          // A turn whose context no longer holds the excerpts of the turns
          // before it (layout current), and what that cost the KV cache:
          // off (no key at all), reused or dropped.
          compacted: trace?.retrieval?.compacted ?? null,
          cache: trace?.retrieval?.cache ?? null,
          search_query: trace?.retrieval?.history ?? null,
          fresh_excerpts: hits.filter((hit) => !hit.reused).length,
          search_calls: (trace?.rounds ?? []).flatMap((r) => r.toolCalls ?? []).filter((call) => call.name === 'search_documents').length,
          rewrite: trace?.retrieval?.rewrite ? { to: trace.retrieval.rewrite.to, used: trace.retrieval.rewrite.used, ms: trace.retrieval.rewrite.ms, tokens: reply.stats?.rewrite_tokens ?? null, error: trace.retrieval.rewrite.error ?? null } : null,
          ...text, ...tools, ...retrieval,
        }
        rows.push(row)
        inContext.push(row)
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
// A retrieval re-score keeps the run's verdicts; every other path grades afresh.
let verdicts = retrievalOnly ? await readJsonl(join(out, 'verdicts.jsonl')) : []
if (!flags['no-judge'] && !retrievalOnly) {
  const judgeConfig = { ...config.judge, ...(flags.judge ? { constant: flags.judge } : {}) }
  const categories = config.judgeCategories ?? ['single']
  const units = []
  for (const category of categories) {
    const rows = turns.filter((t) => t.category === category && !t.error)
    if (category === 'multiturn') {
      const groups = {}
      for (const row of rows) (groups[`${row.id}#${row.run}`] ??= []).push(row)
      for (const [key, group] of Object.entries(groups)) units.push({ key: `multiturn-${key}`, category, rows: group })
    } else if (category === 'multiquery') {
      // One unit per turn, graded against everything the session showed the
      // model up to that turn (excerpts and tool results), else a fact from a
      // chunk three turns back reads as not_in_context. Trimmed from the oldest
      // block when it would not fit the local judge's context.
      const maxChars = judgeBackend === 'claude-cli' ? Infinity : Math.max(4000, ((judgeConfig.ctx ?? 8192) - (judgeConfig.predict ?? 700) - 1500) * 3)
      const groups = {}
      for (const row of rows) (groups[`${row.id}#${row.run}`] ??= []).push(row)
      for (const group of Object.values(groups)) {
        const excerpts = []
        const toolResults = []
        const queries = []
        for (const row of group.sort((a, b) => a.turn - b.turn)) {
          if (row.context) excerpts.push(row.context)
          if (row.toolResults) toolResults.push(row.toolResults)
          const fitted = fitContext(excerpts, maxChars)
          units.push({ key: `multiquery-${row.id}-r${row.run}-t${row.turn}`, category, rows: [row], context: fitted.text, contextTrimmed: fitted.trimmed, toolResults: toolResults.join('\n'), priorQueries: [...queries] })
          queries.push(row.query)
        }
      }
    } else {
      for (const row of rows) units.push({ key: `${category}-${row.id}-r${row.run}-t${row.turn}`, category, rows: [row] })
    }
  }
  if (units.length) {
    log({ judge: judgeName, backend: judgeBackend, units: units.length, batch: judgeConfig.batch }, 'judge starting')
    const t0 = Date.now()
    verdicts = await judge({ units, config: judgeConfig, backend: judgeBackend, log: { info: (f, m) => log(f, m), warn: (f, m) => log(f, m) }, onVerdict: writeVerdict })
    log({ verdicts: verdicts.length, ms: Date.now() - t0 }, 'judge done')
  }
}

const hardware = await readJsonl(join(out, 'hardware.jsonl'))
const metrics = await aggregate({ turns, verdicts, hardware, cases: plan, config, labelsDir: join(here, 'cases', 'labels'), header })
await writeFile(join(out, 'metrics.json'), JSON.stringify(metrics, null, 2))
const report = await buildReport(out)
log(report, 'done')
console.log(`\nreport: ${report.html}`)
