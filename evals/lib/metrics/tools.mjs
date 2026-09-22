// Tool routing and behaviour of one turn, read from the trace's rounds.
// expected: { tool: name | null, args: object | null } from the case.

// The tools the agent may call; anything else in the markup is a hallucinated name.
export const KNOWN_TOOLS = ['lookup_stock', 'list_documents', 'search_documents']

export const toolCallsOf = (trace) => (trace?.rounds ?? []).flatMap((round) => round.toolCalls ?? [])

// The case's significant args are a subset of the call's args (string
// comparison, case-insensitive). No expected args means any args pass.
export const argsSubset = (expected, actual) => {
  if (!expected || !Object.keys(expected).length) return true
  if (!actual) return false
  return Object.entries(expected).every(([key, value]) => String(actual[key] ?? '').toLowerCase() === String(value).toLowerCase())
}

// `hits` are the chunks the turn put in front of the model; the ones a
// search_documents call produced carry via: 'tool' (src/chat/answer.js), so a
// hit without it is retrieval the server ran by itself.
export const autoRetrieved = (hits = []) => hits.some((hit) => !hit.via)

export const scoreTools = (trace, expected = {}, { hits = [] } = {}) => {
  const calls = toolCallsOf(trace)
  const names = calls.map((call) => call.name)
  const wanted = expected.tool ?? null
  const called = names.length > 0
  const matching = wanted ? calls.filter((call) => call.name === wanted) : []
  // Retrieval mode `tool` still searches by itself on the first turn of a
  // session, so a turn that wanted search_documents may already hold the
  // excerpts. Not calling the tool is then right, not a miss: label it
  // `auto` and keep it out of precision and recall.
  const servedByRetrieval = wanted === 'search_documents' && !called && autoRetrieved(hits)
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
    routing: wanted ? (matching.length ? 'tp' : servedByRetrieval ? 'auto' : called ? 'wrong' : 'fn') : (called ? 'fp' : 'tn'),
    args_subset_match: wanted && matching.length ? matching.some((call) => argsSubset(expected.args, call.args)) : null,
    // A call the case did not ask for: a substitute for the wanted tool or a
    // spare one next to it. `unknown_tool` is the harder failure — a name that
    // does not exist, read out of the model's markup.
    wrong_tool: calls.some((call) => !KNOWN_TOOLS.includes(call.name) || (wanted && call.name !== wanted)),
    unknown_tool: calls.some((call) => !KNOWN_TOOLS.includes(call.name)),
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
  // `auto`: the turn wanted search_documents and the server had already run
  // the search, so there was nothing for the model to route. Reported, not scored.
  return { tp, wrong, fp, fn, tn: count('tn'), auto: count('auto'), precision: calls ? tp / calls : null, recall: wanted ? tp / wanted : null }
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
