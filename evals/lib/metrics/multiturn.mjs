import { numbers } from './text.mjs'

// A conversation scored as a whole: elliptical turns resolved, and the same
// fact asked twice answered with the same numbers.
// rows: the scored turns of one multiturn case run, in order.
export const scoreMultiturn = (rows, item) => {
  const followups = item.turns
    .map((turn, i) => ({ turn: i + 1, followup: turn.followup === true }))
    .filter((t) => t.followup)
    .map(({ turn }) => ({ turn, passed: rows.find((row) => row.turn === turn)?.must ?? null }))

  const consistency = (item.consistency ?? []).map(([i, j]) => {
    const a = rows.find((row) => row.turn === i)
    const b = rows.find((row) => row.turn === j)
    if (!a || !b) return { turns: [i, j], consistent: null }
    // Two answers about one fact agree when they share a number (years aside).
    const na = [...numbers(a.text)].filter((v) => !/^(19|20)\d\d$/.test(v))
    const nb = new Set([...numbers(b.text)].filter((v) => !/^(19|20)\d\d$/.test(v)))
    const shared = na.filter((v) => nb.has(v))
    return { turns: [i, j], consistent: na.length && nb.size ? shared.length > 0 : null, shared }
  })

  return { followups, consistency }
}

const rate = (items, key) => {
  const known = items.filter((item) => item[key] !== null && item[key] !== undefined)
  return known.length ? known.filter((item) => item[key] === true).length / known.length : null
}

export const aggregateMultiturn = (scored) => {
  const followups = scored.flatMap((s) => s.followups)
  const pairs = scored.flatMap((s) => s.consistency)
  return {
    n_cases: scored.length,
    followup_resolution: rate(followups, 'passed'),
    n_followups: followups.length,
    consistency: rate(pairs, 'consistent'),
    n_pairs: pairs.length,
  }
}
