// Retrieval quality of one query against its gold documents, by file.
// hits: files in rank order (duplicates from several chunks of one file are
// collapsed, so k counts distinct files).
export const scoreRetrieval = (hitFiles, gold, k = 3) => {
  const files = [...new Set(hitFiles)].slice(0, k)
  const goldSet = new Set(gold)
  const relevant = files.filter((file) => goldSet.has(file))
  const firstRank = files.findIndex((file) => goldSet.has(file))
  return {
    k,
    files,
    recall: goldSet.size ? relevant.length / goldSet.size : null,
    precision: files.length ? relevant.length / files.length : 0,
    mrr: firstRank === -1 ? 0 : 1 / (firstRank + 1),
    hit1: firstRank === 0,
  }
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)

export const aggregateRetrieval = (rows) => ({
  n: rows.length,
  recall_at_k: mean(rows.map((r) => r.recall).filter((v) => v !== null)),
  precision_at_k: mean(rows.map((r) => r.precision)),
  mrr: mean(rows.map((r) => r.mrr)),
  hit_at_1: mean(rows.map((r) => (r.hit1 ? 1 : 0))),
  retrieval_ms_p50: percentile(rows.map((r) => r.retrieval_ms).filter(Number.isFinite), 0.5),
})

export const percentile = (values, p) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index]
}
