// Retrieval quality of one query against its gold documents.
// perK: for each k in K_LIST, the file of every chunk search(query, k)
// returned, in fused rank order, duplicates kept. One search per k, not one
// deep search sliced: RRF fuses the top-k of the vector list with the top-k
// of the full-text list, so the fused order at depth 3 is not the head of
// the order at depth 10. search(query, k) is exactly what the chat would put
// in front of the model with CHAT_TOPK = k (src/chat/answer.js), so k counts
// chunks; a gold file counts once however many of its chunks appear.
export const K_LIST = [1, 3, 4, 5, 7, 10]

export const scoreRetrieval = (perK, gold) => {
  const goldSet = new Set(gold)
  const ks = Object.keys(perK).map(Number).sort((a, b) => a - b)
  const deepest = perK[ks.at(-1)] ?? []
  const at = {}
  for (const k of ks) {
    const top = (perK[k] ?? []).slice(0, k)
    const found = new Set(top.filter((file) => goldSet.has(file)))
    at[k] = {
      // share of the gold files present among the top-k chunks
      recall: goldSet.size ? found.size / goldSet.size : null,
      // share of the top-k chunks that come from a gold file
      precision: top.length ? top.filter((file) => goldSet.has(file)).length / top.length : 0,
      // at least one gold file among the top-k chunks
      hit: found.size > 0,
    }
  }
  const firstRank = deepest.findIndex((file) => goldSet.has(file))
  return {
    ks,
    at,
    // From the deepest search: the distinct files in rank order, where each
    // gold file first appears, and the reciprocal rank of the first gold hit.
    files: [...new Set(deepest)],
    gold_ranks: gold.map((file) => ({ file, rank: deepest.indexOf(file) === -1 ? null : deepest.indexOf(file) + 1 })),
    mrr: firstRank === -1 ? 0 : 1 / (firstRank + 1),
  }
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)

export const aggregateRetrieval = (rows) => {
  const ks = rows[0]?.ks ?? K_LIST
  return {
    n: rows.length,
    ks,
    at: Object.fromEntries(ks.map((k) => [k, {
      recall: mean(rows.map((r) => r.at?.[k]?.recall).filter(Number.isFinite)),
      precision: mean(rows.map((r) => r.at?.[k]?.precision).filter(Number.isFinite)),
      hit: mean(rows.map((r) => (r.at?.[k]?.hit ? 1 : 0))),
    }])),
    mrr: mean(rows.map((r) => r.mrr)),
    retrieval_ms_p50: percentile(rows.map((r) => r.retrieval_ms).filter(Number.isFinite), 0.5),
  }
}

export const percentile = (values, p) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index]
}
