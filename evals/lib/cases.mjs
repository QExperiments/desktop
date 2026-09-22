import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Case files, one JSON object per line. Each category has its own shape (see
// evals/README.md); this module loads them, checks the fields the runner and
// the metrics rely on, and expands every case into case × run.
export const CATEGORIES = ['retrieval', 'agentsearch', 'single', 'abstain', 'tools', 'agent', 'memory', 'multiturn', 'multiquery', 'stress']

// Categories whose turns go through a live session on the server. `tools`
// sends its own history without a session, `retrieval` never calls the model.
// `agent` runs through a session like multiquery: the point of the category
// is what the KV cache does across the turns of one conversation, which a
// stateless request cannot show. `agentsearch` is retrieval.jsonl's queries
// put to the agent loop one turn at a time, so the files the retriever
// returns and the files the agent cites can be read side by side.
export const LIVE = new Set(['single', 'abstain', 'agent', 'agentsearch', 'memory', 'multiturn', 'multiquery', 'stress'])

const required = {
  retrieval: ['query', 'gold_doc_ids'],
  single: ['query', 'gold_doc_ids', 'reference', 'must'],
  abstain: ['query', 'kind'],
  tools: ['messages', 'tool', 'must'],
  agent: ['turns'],
  agentsearch: ['turns', 'gold_doc_ids'],
  memory: ['turns', 'fact_turn', 'recall_turns'],
  multiturn: ['turns'],
  multiquery: ['turns'],
  stress: ['queries'],
}

const check = (category, item, line) => {
  const problems = []
  if (typeof item.id !== 'string' || !item.id) problems.push('id')
  for (const field of required[category]) if (!(field in item)) problems.push(`missing ${field}`)
  if (category === 'tools') {
    if (!Array.isArray(item.messages) || item.messages.at(-1)?.role !== 'user') problems.push('messages must end with a user message')
    if (item.tool !== null && !['lookup_stock', 'list_documents'].includes(item.tool)) problems.push(`tool ${item.tool}`)
  }
  if (category === 'agent') {
    if (!Array.isArray(item.turns) || !item.turns.length) problems.push('turns must hold at least one turn')
    for (const [i, turn] of (item.turns ?? []).entries()) {
      if (typeof turn.query !== 'string' || !turn.query) problems.push(`turn ${i + 1} query`)
      // null is a turn that must call nothing; undefined means the case does not say.
      if (turn.tool !== undefined && turn.tool !== null && !['lookup_stock', 'list_documents', 'search_documents'].includes(turn.tool)) problems.push(`turn ${i + 1} tool ${turn.tool}`)
    }
  }
  if (category === 'abstain' && !['out_of_corpus', 'future', 'near_miss'].includes(item.kind)) problems.push(`kind ${item.kind}`)
  if (category === 'memory') {
    for (const n of item.recall_turns ?? []) if (!item.turns?.[n - 1]?.must) problems.push(`recall turn ${n} has no must`)
    if (!item.turns?.[item.fact_turn - 1]) problems.push(`fact_turn ${item.fact_turn} out of range`)
  }
  if (category === 'multiturn') {
    for (const [i, j] of item.consistency ?? []) if (!item.turns?.[i - 1] || !item.turns?.[j - 1]) problems.push(`consistency pair ${i},${j} out of range`)
  }
  if (category === 'multiquery') {
    if (!Array.isArray(item.turns) || item.turns.length < 2) problems.push('turns must hold at least two turns')
    for (const [i, turn] of (item.turns ?? []).entries()) {
      if (typeof turn.query !== 'string' || !turn.query) problems.push(`turn ${i + 1} query`)
      // Empty gold means the corpus has no answer and the right move is to say so.
      if (!Array.isArray(turn.gold_doc_ids)) problems.push(`turn ${i + 1} gold_doc_ids must be an array`)
    }
  }
  if (problems.length) throw new Error(`${category}.jsonl line ${line} (${item.id ?? '?'}): ${problems.join(', ')}`)
}

// Every turn of a case as the runner plays it: the queries in order, with
// the expectations of that turn attached. Single-turn categories become one turn.
export const turnsOf = (category, item) => {
  if (category === 'stress') return item.queries.map((query, i) => ({ turn: i + 1, query }))
  if (['memory', 'multiturn', 'multiquery', 'agent', 'agentsearch'].includes(category)) return item.turns.map((turn, i) => ({ turn: i + 1, ...turn }))
  if (category === 'tools') return [{ turn: 1, query: item.messages.at(-1).content, history: item.messages.slice(0, -1), tool: item.tool, args: item.args ?? null, must: item.must }]
  return [{ turn: 1, ...item }]
}

export const loadCases = async ({ dir, only = CATEGORIES, runs }) => {
  const plan = {}
  for (const category of CATEGORIES) {
    if (!only.includes(category)) continue
    const text = await readFile(join(dir, `${category}.jsonl`), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    const items = []
    const ids = new Set()
    text.split('\n').forEach((line, index) => {
      if (!line.trim()) return
      const item = JSON.parse(line)
      check(category, item, index + 1)
      if (ids.has(item.id)) throw new Error(`${category}.jsonl: duplicate id ${item.id}`)
      ids.add(item.id)
      items.push(item)
    })
    plan[category] = items.flatMap((item) => {
      // Retrieval is deterministic; one run is enough whatever the config says.
      const count = category === 'retrieval' ? 1 : (item.runs ?? runs)
      return Array.from({ length: count }, (_, i) => ({ category, case: item, run: i + 1, turns: turnsOf(category, item) }))
    })
  }
  return plan
}

export const countTurns = (plan) => Object.values(plan).flat().reduce((total, job) => total + (job.category === 'retrieval' ? 0 : job.turns.length), 0)
