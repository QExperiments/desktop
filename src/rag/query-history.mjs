// The text the retriever searches for when a question arrives with history.
// The question is joined with the previous user questions of the
// conversation, newest first while they fit `turns` and `chars`, and the
// joined text stands in for the elliptical follow-up ("And P2?") without a
// rewrite by the chat model. No SDK, no store: pure text.
//
// Defaults are variant E3 of the 2026-09-21 grid (evals/exp/history-variants
// .json): the last three questions, only when the question looks like a
// follow-up. Joining every question instead costs standalone turns 10 points
// of recall; gated it is +4 at k=3 and k=5. QUERY_HISTORY_TURNS=1 is off.
//
//   QUERY_HISTORY_TURNS  user messages in the search text, current included (default 3, 1 = off)
//   QUERY_HISTORY_CHARS  budget for the joined text, characters (default 600)
//   QUERY_HISTORY_MODE   which leg sees the joined text:
//                        concat  both legs (default)
//                        vector  vector leg only; BM25 keeps the question alone
//                        fts     BM25 leg only; the vector leg keeps the question alone
//                        fuse    both legs search twice, question alone and joined, and RRF fuses all lists
//   QUERY_HISTORY_ORDER  oldest (default: chronological) or newest (current question first)
//   QUERY_HISTORY_WHEN   elliptical (default: only when the question looks like a follow-up,
//                        see looksElliptical) | always | oracle (eval only: the case says so)
export const historyConfig = () => ({
  turns: Math.max(1, Number(process.env.QUERY_HISTORY_TURNS || 3)),
  chars: Math.max(1, Number(process.env.QUERY_HISTORY_CHARS || 600)),
  mode: ['concat', 'vector', 'fts', 'fuse'].includes(process.env.QUERY_HISTORY_MODE) ? process.env.QUERY_HISTORY_MODE : 'concat',
  order: process.env.QUERY_HISTORY_ORDER === 'newest' ? 'newest' : 'oldest',
  when: ['always', 'elliptical', 'oracle'].includes(process.env.QUERY_HISTORY_WHEN) ? process.env.QUERY_HISTORY_WHEN : 'elliptical',
})

// A question that cannot be searched on its own: it opens like a continuation
// ("And P2?", "So what was it again?"), points back with a pronoun or a
// demonstrative ("their EBR", "that deal"), or is too short to name its subject
// ("How much was APAC?"). Plain rules, no model; the eval measures them
// against the hand labels of evals/exp/cases-history.
const OPENERS = /^\s*(and|also|then|so|what about|how about|remind me|again)\b/i
const REFERENTS = /\b(it|its|they|them|their|theirs|that|those|this|these|same|he|she|him|her|his|hers)\b/i
export const looksElliptical = (query = '') => OPENERS.test(query) || REFERENTS.test(query) || query.trim().split(/\s+/).filter(Boolean).length <= 4

// The current question plus the most recent earlier questions that fit; the
// current one is always in, duplicates and blanks are skipped.
export const historyText = (query, previous = [], { turns = 1, chars = 600, order = 'oldest' } = {}) => {
  const picked = [query]
  let length = query.length
  for (let i = previous.length - 1; i >= 0 && picked.length < turns; i--) {
    const q = (previous[i] ?? '').trim()
    if (!q || picked.includes(q)) continue
    if (length + q.length + 1 > chars) break
    picked.push(q)
    length += q.length + 1
  }
  return (order === 'newest' ? picked : picked.reverse()).join(' ')
}

// The texts each retrieval leg searches for. `joined` is null when the search
// text is the question alone (no history, turns = 1, or nothing fitted).
// `followup` is the case label, read only when QUERY_HISTORY_WHEN=oracle.
export const queryTexts = (query, previous = [], cfg = historyConfig(), { followup = null } = {}) => {
  const alone = { vectorTexts: [query], ftsTexts: [query], joined: null }
  if (cfg.turns <= 1) return alone
  if (cfg.when === 'elliptical' && !looksElliptical(query)) return alone
  if (cfg.when === 'oracle' && !followup) return alone
  const joined = historyText(query, previous, cfg)
  if (joined === query) return alone
  if (cfg.mode === 'vector') return { vectorTexts: [joined], ftsTexts: [query], joined }
  if (cfg.mode === 'fts') return { vectorTexts: [query], ftsTexts: [joined], joined }
  if (cfg.mode === 'fuse') return { vectorTexts: [query, joined], ftsTexts: [query, joined], joined }
  return { vectorTexts: [joined], ftsTexts: [joined], joined }
}
