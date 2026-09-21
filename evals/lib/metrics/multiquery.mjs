// Retrieval of a multi-query session, turn by turn, from the hits the chat
// actually put in front of the model: trace.hits is search(query, CHAT_TOPK),
// so k here is what the model saw (3 chunks today), not a chosen depth.
// Reused chunks (shown earlier in the session, not repeated in the prompt)
// are still hits: retrieval found them; the model has them in its context.
export const scoreMultiqueryTurn = ({ hits = [], gold = [], shownBefore = new Set() }) => {
  const files = hits.map((hit) => hit.file)
  const goldSet = new Set(gold)
  const empty = { has_gold: goldSet.size > 0, k: files.length, files: [...new Set(files)], gold_ranks: [], recall: null, precision: null, hit: null, mrr: null, evidence_in_context: null, context_recall: null }
  if (!goldSet.size) return empty
  const found = new Set(files.filter((file) => goldSet.has(file)))
  // Gold the model can read on this turn: retrieved now, or shown earlier in
  // the session and still in the KV context.
  const inContext = new Set([...found, ...[...shownBefore].filter((file) => goldSet.has(file))])
  const firstRank = files.findIndex((file) => goldSet.has(file))
  return {
    ...empty,
    gold_ranks: gold.map((file) => ({ file, rank: files.indexOf(file) === -1 ? null : files.indexOf(file) + 1 })),
    // share of the gold files among the k chunks
    recall: found.size / goldSet.size,
    // share of the k chunks that come from a gold file
    precision: files.length ? files.filter((file) => goldSet.has(file)).length / files.length : 0,
    hit: found.size > 0,
    mrr: firstRank === -1 ? 0 : 1 / (firstRank + 1),
    evidence_in_context: inContext.size > 0,
    context_recall: inContext.size / goldSet.size,
  }
}

const mean = (values) => {
  const known = values.filter((v) => Number.isFinite(v))
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null
}
const rate = (values) => {
  const known = values.filter((v) => v === true || v === false)
  return known.length ? known.filter(Boolean).length / known.length : null
}

const block = (rows) => ({
  n: rows.length,
  recall: mean(rows.map((r) => r.recall)),
  precision: mean(rows.map((r) => r.precision)),
  hit: rate(rows.map((r) => r.hit)),
  mrr: mean(rows.map((r) => r.mrr)),
  evidence_in_context: rate(rows.map((r) => r.evidence_in_context)),
  context_recall: mean(rows.map((r) => r.context_recall)),
})

// Over every scored multiquery turn: the whole set, the follow-up and
// standalone splits (does an elliptical query still retrieve?), and the turns
// whose right answer is a refusal.
export const aggregateMultiquery = (rows) => {
  const gold = rows.filter((r) => r.has_gold)
  const noAnswer = rows.filter((r) => r.has_gold === false)
  return {
    n_turns: rows.length,
    k: rows[0]?.k ?? 3,
    all: block(gold),
    followup: block(gold.filter((r) => r.followup)),
    standalone: block(gold.filter((r) => !r.followup)),
    no_answer: {
      n: noAnswer.length,
      // the code's read of a refusal; the judge's `answered` is the other read
      abstained_rate: rate(noAnswer.map((r) => r.abstained)),
      grounded_rate: rate(noAnswer.map((r) => r.grounded)),
    },
  }
}
