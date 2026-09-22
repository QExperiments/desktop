// Checks on the answer text alone, or against the excerpts and tool results
// the model was shown. Definitions follow the code-metric list in docs/todo.md.

const toRegExp = (pattern) => (pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i'))

// At least one of the patterns (strings or regex sources) matches the answer.
export const must = (text, patterns = []) => {
  if (!patterns.length) return null
  return patterns.some((pattern) => toRegExp(pattern).test(text))
}

// Numbers in a text, normalised: thousands separators dropped, trailing .0
// removed, $ and % stripped, "18.4M" kept as 18.4 and also 18400000. Years
// and 1-digit list markers stay in; they rarely collide with facts.
export const numbers = (text) => {
  const out = new Set()
  for (const match of text.matchAll(/\d[\d,]*(?:\.\d+)?\s*(?:M\b|million\b|K\b|k\b)?/g)) {
    const raw = match[0]
    const value = parseFloat(raw.replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    const normal = (n) => String(Number(n.toFixed(4)))
    out.add(normal(value))
    if (/M\b|million\b/.test(raw)) out.add(normal(value * 1_000_000))
    if (/K\b|k\b/.test(raw)) out.add(normal(value * 1000))
  }
  return out
}

// Share of the reference's numbers that the answer contains.
export const numberMatch = (text, reference) => {
  const wanted = numbers(reference ?? '')
  if (!wanted.size) return null
  const have = numbers(text)
  let found = 0
  for (const value of wanted) if (have.has(value)) found++
  return found / wanted.size
}

// Every number in the answer appears in the excerpts or tool results shown.
// Years alone (2026) are not held against the answer; they come from dates
// the model paraphrases.
export const grounded = (text, context) => {
  const have = numbers(text)
  if (!have.size) return true
  const allowed = numbers(context ?? '')
  for (const value of have) {
    if (/^(19|20)\d\d$/.test(value)) continue
    if (!allowed.has(value)) return false
  }
  return true
}

// Cited files that are gold, over cited files (the stock tool counts as a
// file only when the case lists it).
export const citationPrecision = (citations, gold = []) => {
  const files = [...new Set((citations ?? []).map((c) => c.file))]
  if (!files.length) return null
  const goldSet = new Set(gold)
  return files.filter((file) => goldSet.has(file)).length / files.length
}

// Gold files among the files the answer cited. The mirror of
// citationPrecision, and the number that makes an agent turn comparable with
// a plain retrieval query: the retriever is judged on what it returned, the
// agent on what it actually used after however many searches it ran.
export const citationRecall = (citations, gold = []) => {
  if (!gold.length) return null
  const files = new Set((citations ?? []).map((c) => c.file))
  return gold.filter((file) => files.has(file)).length / gold.length
}

// A failed request has no text at all, and a metric must not be the thing
// that takes the run down: score it as unknown and let `status`/`error` carry
// the failure.
const cyrillic = (text) => (String(text ?? '').match(/[Ѐ-ӿ]/g) ?? []).length
const latin = (text) => (String(text ?? '').match(/[A-Za-z]/g) ?? []).length
export const langOf = (text) => (cyrillic(text) > latin(text) ? 'ru' : latin(text) ? 'en' : null)

// The answer is in the language of the query (alphabet heuristic).
export const langMatch = (query, text) => {
  const want = langOf(query)
  const got = langOf(text)
  if (!want || !got) return null
  return want === got
}

export const empty = (text) => (text ?? '').trim() === ''

// Markup or prompt text that should never reach a person. The closing
// </think> counts too: 2026-09-18 three multiquery answers carried it with a
// second draft of the answer after it, while the opening tag had been captured.
const LEAKS = [/<\/?think>/i, /<tool_call>/i, /\{"name":/, /\/no_think/, /You are Meridian/, /\[\d+\] source:/, /<\|im_(start|end)\|>/]
export const leak = (text) => LEAKS.some((pattern) => pattern.test(text ?? ''))

// The answer declines: says the documents or data do not hold it. The
// category decides whether that is right (abstain wants true, single false).
const ABSTAIN = [
  /not (?:in|part of|covered by|mentioned in|stated in|available in|present in|found in) (?:the |our |these |those |any )?(?:corpus|document|data|records|sources|files|knowledge|context|excerpt)/i,
  /(?:do|does|did) not (?:have|contain|include|hold|mention|specify|state|provide|list)/i,
  /(?:don't|doesn't|didn't) (?:have|contain|include|hold|mention|specify|state|provide|list)/i,
  /no (?:information|data|record|records|mention|details?|figure|documentation|document)\b/i,
  /(?:i )?(?:cannot|can't|am unable to|unable to) (?:find|answer|determine|confirm|provide|verify|locate)/i,
  /(?:isn't|is not|aren't|are not) (?:available|documented|specified|stated|mentioned|listed|provided|included|covered)/i,
  /(?:нет|не содерж|не наш|отсутству|не указан|не могу (?:найти|ответить|подтвердить))/i,
  /unknown sku|no matching|no matches|not found|does not exist|no such/i,
]
export const abstained = (text) => ABSTAIN.some((pattern) => pattern.test(text ?? ''))

export const scoreText = ({ query, text, citations, gold = [], reference, mustPatterns, context }) => ({
  must: must(text, mustPatterns ?? []),
  number_match: numberMatch(text, reference),
  grounded: grounded(text, context),
  citation_precision: citationPrecision(citations, gold),
  citation_recall: citationRecall(citations, gold),
  lang: langMatch(query, text),
  empty: empty(text),
  leak: leak(text),
  abstained: abstained(text),
})
