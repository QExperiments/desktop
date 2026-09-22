// Memory across a session: did a later turn get a fact the session already
// held, and did it read it from the context or fetch it again.
// rows: the scored turns of one memory case run, in order.
export const scoreMemory = (rows, item) => {
  const fact = rows.find((row) => row.turn === item.fact_turn)
  const factFiles = new Set((fact?.hits ?? []).map((hit) => hit.file))
  const factTools = new Set((fact?.tool_calls ?? []).map((call) => call.name))
  const recalls = item.recall_turns.map((n) => {
    const row = rows.find((r) => r.turn === n)
    if (!row) return { turn: n, d: n - item.fact_turn, passed: null }
    const passed = row.must === true
    const freshFiles = (row.hits ?? []).filter((hit) => !hit.reused).map((hit) => hit.file)
    const sameTool = (row.tool_calls ?? []).some((call) => factTools.has(call.name))
    // Fetched again when the recall turn called the fact's tool once more or
    // retrieval put a chunk of the fact's file in front of the model anew.
    const reFetched = passed && (sameTool || freshFiles.some((file) => factFiles.has(file)))
    return {
      turn: n,
      d: n - item.fact_turn,
      passed,
      re_fetched: reFetched,
      recalled_from_memory: passed && !reFetched && (row.rounds ?? 1) === 1,
      prompt_tokens: row.usage?.prompt_tokens ?? null,
    }
  })
  return { recalls, memory_at_d: recalls.map(({ d, passed }) => ({ d, passed })) }
}

// memory@d over every memory case run: share of recall turns at distance d that passed.
export const aggregateMemory = (scored) => {
  const byD = {}
  for (const { recalls } of scored) {
    for (const recall of recalls) {
      if (recall.passed === null) continue
      byD[recall.d] ??= { d: recall.d, n: 0, passed: 0, from_memory: 0, re_fetched: 0 }
      byD[recall.d].n++
      if (recall.passed) byD[recall.d].passed++
      if (recall.recalled_from_memory) byD[recall.d].from_memory++
      if (recall.re_fetched) byD[recall.d].re_fetched++
    }
  }
  const all = Object.values(byD).sort((a, b) => a.d - b.d)
  const total = all.reduce((sum, row) => sum + row.n, 0)
  return {
    n_recalls: total,
    memory_overall: total ? all.reduce((sum, row) => sum + row.passed, 0) / total : null,
    by_d: all.map((row) => ({ ...row, rate: row.passed / row.n })),
    recalled_from_memory: total ? all.reduce((sum, row) => sum + row.from_memory, 0) / total : null,
    re_fetched: total ? all.reduce((sum, row) => sum + row.re_fetched, 0) / total : null,
  }
}
