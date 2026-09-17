import { readFile } from 'node:fs/promises'
import * as sdk from '@qvac/sdk'
import { SCHEMAS, derive, jsonSchemaFor } from './schemas.mjs'

// LLM-as-judge on a local model larger than the one under test. Runs only
// after the server has stopped, so its memory never overlaps the phases the
// sampler measured. Verdicts come back as JSON constrained by a grammar
// (SDK responseFormat json_schema); the code then verifies every quoted
// evidence string against the context and derives the numbers.

const promptsDir = new URL('./prompts/', import.meta.url)
const SYSTEM = 'You are a strict, literal grader. Follow the instructions and answer with one JSON object only.'

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '')

const transcriptOf = (rows) => rows.map((row) => [
  `--- Turn ${row.turn}${row.followup ? ' (follow-up)' : ''} ---`,
  row.context ? `Shown to the assistant (excerpts):\n${row.context}` : 'Shown to the assistant: no new excerpts',
  row.toolResults ? `Tool results:\n${row.toolResults}` : '',
  `User: ${row.query}`,
  `Assistant: ${row.text}`,
].filter(Boolean).join('\n')).join('\n\n')

// One judge prompt per unit: a single turn for single/abstain, a whole case run for multiturn.
export const buildPrompt = (category, template, unit) => {
  if (category === 'multiturn') return fill(template, { transcript: transcriptOf(unit.rows) })
  const row = unit.rows[0]
  return fill(template, {
    query: row.query,
    reference: row.reference ?? row.note ?? '',
    context: row.context || '(none)',
    tool_results: row.toolResults || '(none)',
    answer: row.text || '(empty answer)',
  })
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

// units: [{ key, category, rows: [turn rows] }]. Returns one verdict row per unit.
export const judge = async ({ units, config, log = console, onVerdict }) => {
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
  log.info?.({ judge: config.constant, loadMs: Date.now() - t0 }, 'judge loaded')
  const out = []

  const grade = (unit, text, ms, via) => {
    const parsed = parse(unit.category, text)
    const context = unit.rows.map((row) => `${row.context ?? ''}\n${row.toolResults ?? ''}`).join('\n')
    const verdict = parsed.ok ? parsed.verdict : null
    const row = {
      category: unit.category, key: unit.key, id: unit.rows[0].id, run: unit.rows[0].run, turn: unit.rows[0].turn, requestId: unit.rows[0].requestId,
      parse_ok: parsed.ok, error: parsed.ok ? null : parsed.error, verdict, derived: verdict ? derive[unit.category](verdict, context) : null, ms, via, raw: parsed.ok ? undefined : text.slice(0, 500),
    }
    out.push(row)
    onVerdict?.(row)
  }

  try {
    for (const [category, list] of Object.entries(byCategory)) {
      const template = await readFile(new URL(`${category}.md`, promptsDir), 'utf8')
      const responseFormat = jsonSchemaFor(category)
      const generationParams = { temp: config.temp ?? 0, predict: config.predict ?? 700 }
      const batchSize = Math.max(1, config.batch ?? 1)
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
