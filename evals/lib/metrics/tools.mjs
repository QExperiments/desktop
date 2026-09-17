// Tool routing and behaviour of one turn, read from the trace's rounds.
// expected: { tool: name | null, args: object | null } from the case.

export const toolCallsOf = (trace) => (trace?.rounds ?? []).flatMap((round) => round.toolCalls ?? [])

// The case's significant args are a subset of the call's args (string
// comparison, case-insensitive). No expected args means any args pass.
export const argsSubset = (expected, actual) => {
  if (!expected || !Object.keys(expected).length) return true
  if (!actual) return false
  return Object.entries(expected).every(([key, value]) => String(actual[key] ?? '').toLowerCase() === String(value).toLowerCase())
}

export const scoreTools = (trace, expected = {}) => {
  const calls = toolCallsOf(trace)
  const names = calls.map((call) => call.name)
  const wanted = expected.tool ?? null
  const called = names.length > 0
  const matching = wanted ? calls.filter((call) => call.name === wanted) : []
  const seen = new Set()
  let repeats = 0
  for (const call of calls) {
    const key = `${call.name}:${JSON.stringify(call.args ?? {})}`
    if (seen.has(key)) repeats++
    seen.add(key)
  }
  return {
    expected_tool: wanted,
    called: names,
    // routing: TP = wanted and called it; FP = called though none wanted, or a different tool; FN = wanted but not called
    routing: wanted ? (matching.length ? 'tp' : called ? 'wrong' : 'fn') : (called ? 'fp' : 'tn'),
    args_subset_match: wanted && matching.length ? matching.some((call) => argsSubset(expected.args, call.args)) : null,
    wrong_tool: calls.some((call) => !['lookup_stock', 'list_documents'].includes(call.name) || (wanted && call.name !== wanted)),
    rounds: trace?.rounds?.length ?? null,
    repeat_calls: repeats,
    limit_hits: calls.filter((call) => /already called/.test(call.error ?? '')).length,
    tool_errors: calls.filter((call) => call.error && !/already called/.test(call.error)).length,
    tool_ms: calls.reduce((sum, call) => sum + (call.ms ?? 0), 0),
  }
}

// Precision and recall of routing over a set of scored rows.
export const routingPR = (rows) => {
  const count = (label) => rows.filter((row) => row.routing === label).length
  const tp = count('tp')
  const wrong = count('wrong')
  const fp = count('fp')
  const fn = count('fn')
  const calls = tp + wrong + fp
  const wanted = tp + wrong + fn
  return { tp, wrong, fp, fn, tn: count('tn'), precision: calls ? tp / calls : null, recall: wanted ? tp / wanted : null }
}

// Per-turn and per-tool call statistics for the categories that run sessions.
export const toolStats = (rows) => {
  const calls = rows.flatMap((row) => row.tool_calls ?? [])
  const perTool = {}
  for (const call of calls) perTool[call.name] = (perTool[call.name] ?? 0) + 1
  const turns = rows.length || 1
  return {
    turns: rows.length,
    calls: calls.length,
    calls_per_turn: Number((calls.length / turns).toFixed(2)),
    turns_with_tool: rows.filter((row) => (row.tool_calls ?? []).length > 0).length / turns,
    per_tool: perTool,
    rounds_mean: Number((rows.reduce((sum, row) => sum + (row.rounds ?? 1), 0) / turns).toFixed(2)),
    repeat_calls: rows.reduce((sum, row) => sum + (row.repeat_calls ?? 0), 0),
    limit_hits: rows.reduce((sum, row) => sum + (row.limit_hits ?? 0), 0),
    tool_errors: rows.reduce((sum, row) => sum + (row.tool_errors ?? 0), 0),
    tool_ms_total: rows.reduce((sum, row) => sum + (row.tool_ms ?? 0), 0),
  }
}
