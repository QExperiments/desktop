// Builds evals/exp/cases-history/retrieval.jsonl from evals/cases/multiquery.jsonl:
// one retrieval case per turn with gold, carrying the earlier user questions of
// its session in `history`, so evals/retrieval-exp.mjs can measure how the
// search text is built from the dialogue (QUERY_HISTORY_*) without an LLM.
//   node evals/exp/build-history-cases.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sessions = (await readFile(join(here, '..', 'cases', 'multiquery.jsonl'), 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
const cases = []
for (const session of sessions) {
  const questions = []
  session.turns.forEach((turn, i) => {
    const history = [...questions]
    questions.push(turn.query)
    if (!turn.gold_doc_ids?.length) return
    cases.push({
      id: `${session.id}-t${i + 1}`,
      query: turn.query,
      history,
      gold_doc_ids: turn.gold_doc_ids,
      tags: [`kind:${turn.followup ? 'followup' : 'standalone'}`, `turn:${i + 1}`, `session:${session.id}`, `history:${history.length}`, ...(session.tags ?? [])],
    })
  })
}
const outDir = join(here, 'cases-history')
await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, 'retrieval.jsonl'), cases.map((c) => `${JSON.stringify(c)}\n`).join(''))
const followups = cases.filter((c) => c.tags.includes('kind:followup')).length
console.log(`${cases.length} cases (${followups} follow-up, ${cases.length - followups} standalone) from ${sessions.length} sessions -> ${join(outDir, 'retrieval.jsonl')}`)
