#!/usr/bin/env node
// Turns the 133 retrieval queries into single-turn live cases, so the same
// questions can be asked of the plain retriever (no LLM) and of the agent
// loop, and the two answers compared on the files each ends up citing.
// The queries and the gold stay in retrieval.jsonl; this file is generated.
//
//   node evals/exp/build-agentsearch-cases.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const here = new URL('../cases/', import.meta.url).pathname
const rows = (await readFile(join(here, 'retrieval.jsonl'), 'utf8'))
  .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))

const cases = rows.map((row) => ({
  id: row.id.replace(/^retrieval/, 'agentsearch'),
  kind: 'agentsearch',
  note: 'the retrieval query put to the agent loop; it searches for itself',
  gold_doc_ids: row.gold_doc_ids ?? [],
  tags: row.tags ?? [],
  // No expected tool: the point is what the agent cites, not which tool it
  // picked. A stock question has no gold document and scores as no_answer.
  turns: [{ turn: 1, query: row.query, gold_doc_ids: row.gold_doc_ids ?? [] }],
}))

await writeFile(join(here, 'agentsearch.jsonl'), cases.map((c) => JSON.stringify(c)).join('\n') + '\n')
console.log(`agentsearch.jsonl: ${cases.length} cases from retrieval.jsonl`)
