import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as sdk from '@qvac/sdk'
import { SCHEMAS, derive, jsonSchemaFor } from './schemas.mjs'

// LLM-as-judge with two backends.
// - local (the default): a model larger than the one under test, loaded after
//   the server has stopped so its memory never overlaps the phases the sampler
//   measured. Verdicts come back as JSON constrained by a grammar (SDK
//   responseFormat json_schema).
// - claude-cli: `claude -p --model haiku --json-schema` through the Claude Code
//   CLI installed on this machine. Everything in the prompt, corpus excerpts
//   included, goes to Anthropic, which the project's non-negotiables forbid for
//   the product. It exists for the harness alone, runs only when
//   `--judge-backend claude-cli` is passed on the command line, and is never a
//   default or a config.json setting.
// Either way the code then verifies every quoted evidence string against the
// context and derives the numbers (schemas.mjs).

const promptsDir = new URL('./prompts/', import.meta.url)
export const SYSTEM = 'You are a strict, literal grader. Follow the instructions and answer with one JSON object only.'

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '')

const transcriptOf = (rows) => rows.map((row) => [
  `--- Turn ${row.turn}${row.followup ? ' (follow-up)' : ''} ---`,
  row.context ? `Shown to the assistant (excerpts):\n${row.context}` : 'Shown to the assistant: no new excerpts',
  row.toolResults ? `Tool results:\n${row.toolResults}` : '',
  `User: ${row.query}`,
  `Assistant: ${row.text}`,
].filter(Boolean).join('\n')).join('\n\n')

// One judge prompt per unit: a single turn for single/abstain, a whole case
// run for multiturn, one turn with the session's accumulated context for
// multiquery (unit.context, unit.toolResults, unit.priorQueries).
export const buildPrompt = (category, template, unit) => {
  if (category === 'multiturn') return fill(template, { transcript: transcriptOf(unit.rows) })
  const row = unit.rows[0]
  return fill(template, {
    query: row.query,
    reference: row.reference ?? row.note ?? '',
    prior_queries: unit.priorQueries?.length ? unit.priorQueries.map((q, i) => `${i + 1}. ${q}`).join('\n') : '(none, this is the first turn)',
    context: (unit.context ?? row.context) || '(none)',
    tool_results: (unit.toolResults ?? row.toolResults) || '(none)',
    answer: row.text || '(empty answer)',
  })
}

// The text evidence quotes are verified against: the accumulated context a
// multiquery unit carries, otherwise the unit's own turns.
export const contextOfUnit = (unit) => (unit.context !== undefined
  ? `${unit.context}\n${unit.toolResults ?? ''}`
  : unit.rows.map((row) => `${row.context ?? ''}\n${row.toolResults ?? ''}`).join('\n'))

// Accumulated excerpts must fit the judge's context. The oldest blocks go
// first and the verdict says how many; about 3 characters per token for these
// documents (markdown tables and numbers tokenize densely).
export const fitContext = (blocks, maxChars) => {
  const kept = [...blocks]
  let trimmed = 0
  while (kept.length > 1 && kept.join('\n\n').length > maxChars) {
    kept.shift()
    trimmed++
  }
  return { text: kept.join('\n\n'), trimmed }
}

const parse = (category, text) => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) return { ok: false, error: 'no JSON object in output' }
  try {
    const result = SCHEMAS[category].safeParse(JSON.parse(text.slice(start, end + 1)))
    return result.success ? { ok: true, verdict: result.data } : { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

// One verdict row per unit, whichever backend produced the text.
const grader = ({ out, onVerdict }) => (unit, text, ms, via, extra = {}) => {
  const parsed = parse(unit.category, text)
  const verdict = parsed.ok ? parsed.verdict : null
  const row = {
    category: unit.category, key: unit.key, id: unit.rows[0].id, run: unit.rows[0].run, turn: unit.rows[0].turn, requestId: unit.rows[0].requestId,
    parse_ok: parsed.ok, error: parsed.ok ? null : parsed.error, verdict, derived: verdict ? derive[unit.category](verdict, contextOfUnit(unit)) : null,
    ms, via, context_trimmed: unit.contextTrimmed ?? 0, ...extra, raw: parsed.ok ? undefined : text.slice(0, 500),
  }
  out.push(row)
  onVerdict?.(row)
  return row
}

// units: [{ key, category, rows: [turn rows], context?, toolResults?, priorQueries?, contextTrimmed? }].
// Returns one verdict row per unit, in unit order.
export const judge = async ({ units, config, backend = 'local', log = console, onVerdict }) => {
  if (backend === 'claude-cli') return judgeWithClaudeCli({ units, config, log, onVerdict })
  if (backend !== 'local') throw new Error(`unknown judge backend ${backend}; use local or claude-cli`)

  const byCategory = {}
  for (const unit of units) (byCategory[unit.category] ??= []).push(unit)
  const modelSrc = sdk[config.constant]
  if (!modelSrc) throw new Error(`${config.constant} is not in the @qvac/sdk catalog`)

  const t0 = Date.now()
  // reasoning_budget 0 turns Qwen3.5's thinking off at load. With thinking on,
  // the grammar of responseFormat breaks ("empty grammar stack") and every
  // verdict costs a thousand tokens of scratchpad first.
  // batchCompletion needs the model loaded with `parallel` sequences, and
  // llama.cpp splits the context between them, so the context grows with the batch.
  const batchSize = Math.max(1, config.batch ?? 1)
  const ctx = Math.max(config.ctx ?? 8192, batchSize * 4096)
  const modelId = await sdk.loadModel({ modelSrc, modelConfig: { ctx_size: ctx, parallel: batchSize, reasoning_budget: config.reasoningBudget ?? 0 } })
  log.info?.({ judge: config.constant, ctx, loadMs: Date.now() - t0 }, 'judge loaded')
  const out = []
  const grade = grader({ out, onVerdict })

  try {
    for (const [category, list] of Object.entries(byCategory)) {
      const template = await readFile(new URL(`${category}.md`, promptsDir), 'utf8')
      const responseFormat = jsonSchemaFor(category)
      const generationParams = { temp: config.temp ?? 0, predict: config.predict ?? 700 }
      for (let i = 0; i < list.length; i += batchSize) {
        const batch = list.slice(i, i + batchSize)
        const prompts = batch.map((unit) => ({
          id: unit.key,
          history: [{ role: 'system', content: SYSTEM }, { role: 'user', content: buildPrompt(category, template, unit) }],
          generationParams,
          responseFormat,
        }))
        const started = Date.now()
        // Decode is memory-bound, so a batch of four costs little more than
        // one; prefill is not shared. Any batch-level failure falls back to
        // one completion per unit so a single bad row cannot sink the rest.
        try {
          if (batch.length > 1) {
            const run = sdk.batchCompletion({ modelId, prompts })
            // The run's other promises reject together with results; left
            // unobserved they would take the process down.
            run.ids?.catch?.(() => {})
            run.stats?.catch?.(() => {})
            const results = await run.results
            const ms = Math.round((Date.now() - started) / batch.length)
            for (const unit of batch) {
              const result = results.find((r) => r.id === unit.key) ?? results[batch.indexOf(unit)]
              grade(unit, result?.final?.contentText ?? '', ms, 'batch')
            }
            continue
          }
          throw new Error('single')
        } catch (error) {
          if (error.message !== 'single') log.warn?.({ err: error.message }, 'batch judge failed; grading one by one')
          for (const [j, unit] of batch.entries()) {
            const one = Date.now()
            try {
              const run = sdk.completion({ modelId, ...prompts[j], stream: false })
              const final = await run.final
              grade(unit, final.contentText ?? '', Date.now() - one, 'single')
            } catch (single) {
              log.warn?.({ key: unit.key, err: single.message.split('\n')[0] }, 'judge failed on one unit')
              grade(unit, '', Date.now() - one, 'error')
            }
          }
        }
        log.info?.({ category, done: Math.min(i + batchSize, list.length), of: list.length }, 'judge progress')
      }
    }
  } finally {
    await sdk.unloadModel({ modelId }).catch(() => {})
  }
  return out
}

// ---- claude-cli backend -----------------------------------------------------

// One `claude -p` call. cwd is a temp directory so the CLI loads no project
// instructions; the MCP servers and built-in tools of this machine's Claude
// Code are switched off (they would ride along as tens of thousands of prompt
// tokens); the nesting guard is lifted so the harness runs from inside a
// Claude Code session too. `--json-schema` makes the CLI return the verdict
// as `structured_output` in its JSON envelope.
const runClaude = ({ model, schema, system, prompt, timeoutMs }) => new Promise((resolve, reject) => {
  const env = { ...process.env }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  const args = ['-p', '--model', model, '--system-prompt', system, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--json-schema', JSON.stringify(schema), '--output-format', 'json']
  const child = spawn('claude', args, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { err += chunk })
  child.on('error', (error) => { clearTimeout(timer); reject(error) })
  child.on('close', (code) => {
    clearTimeout(timer)
    if (code !== 0) return reject(new Error(`claude exited ${code}: ${(err || out).trim().slice(0, 300)}`))
    try {
      const envelope = JSON.parse(out)
      if (envelope.is_error) return reject(new Error(`claude: ${String(envelope.result ?? '').slice(0, 300)}`))
      resolve({
        text: envelope.structured_output ? JSON.stringify(envelope.structured_output) : String(envelope.result ?? ''),
        cost: envelope.total_cost_usd ?? null,
        model: Object.keys(envelope.modelUsage ?? {})[0] ?? model,
        tokens: (envelope.usage?.input_tokens ?? 0) + (envelope.usage?.cache_creation_input_tokens ?? 0) + (envelope.usage?.cache_read_input_tokens ?? 0),
      })
    } catch {
      reject(new Error(`claude output was not JSON: ${out.slice(0, 200)}`))
    }
  })
  child.stdin.end(prompt)
})

const judgeWithClaudeCli = async ({ units, config, log, onVerdict }) => {
  const out = []
  const grade = grader({ out, onVerdict })
  const model = config.cliModel ?? 'haiku'
  const parallel = Math.max(1, Math.min(config.cliParallel ?? 4, units.length))
  const templates = {}
  log.warn?.({ backend: 'claude-cli', model, units: units.length }, 'judge prompts, corpus excerpts included, leave this machine for Anthropic (explicit --judge-backend)')
  let next = 0
  const worker = async () => {
    while (next < units.length) {
      const unit = units[next++]
      templates[unit.category] ??= await readFile(new URL(`${unit.category}.md`, promptsDir), 'utf8')
      const prompt = buildPrompt(unit.category, templates[unit.category], unit)
      const started = Date.now()
      try {
        const result = await runClaude({ model, schema: jsonSchemaFor(unit.category).json_schema.schema, system: SYSTEM, prompt, timeoutMs: config.cliTimeoutMs ?? 180_000 })
        grade(unit, result.text, Date.now() - started, 'claude-cli', { cost_usd: result.cost, model: result.model, prompt_tokens: result.tokens })
      } catch (error) {
        log.warn?.({ key: unit.key, err: error.message }, 'claude-cli judge failed on one unit')
        grade(unit, '', Date.now() - started, 'error')
      }
      if (out.length % 10 === 0 || out.length === units.length) {
        log.info?.({ done: out.length, of: units.length, cost_usd: Number(out.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0).toFixed(3)) }, 'judge progress')
      }
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker))
  const order = new Map(units.map((unit, i) => [unit.key, i]))
  out.sort((a, b) => order.get(a.key) - order.get(b.key))
  return out
}

// Agreement between two label sequences (Cohen's kappa). Values are compared as strings.
export const kappa = (a, b) => {
  const n = Math.min(a.length, b.length)
  if (!n) return null
  const labels = new Set([...a, ...b].map(String))
  let agree = 0
  const countA = {}
  const countB = {}
  for (let i = 0; i < n; i++) {
    const x = String(a[i])
    const y = String(b[i])
    if (x === y) agree++
    countA[x] = (countA[x] ?? 0) + 1
    countB[y] = (countB[y] ?? 0) + 1
  }
  const po = agree / n
  let pe = 0
  for (const label of labels) pe += ((countA[label] ?? 0) / n) * ((countB[label] ?? 0) / n)
  return pe === 1 ? 1 : (po - pe) / (1 - pe)
}
