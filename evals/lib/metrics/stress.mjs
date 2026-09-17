import { percentile } from './retrieval.mjs'

// Slope of y over x by least squares; the memory and latency trends.
export const slope = (points) => {
  const n = points.length
  if (n < 2) return null
  const mx = points.reduce((s, [x]) => s + x, 0) / n
  const my = points.reduce((s, [, y]) => s + y, 0) / n
  const sxx = points.reduce((s, [x]) => s + (x - mx) ** 2, 0)
  if (!sxx) return null
  return points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / sxx
}

const finite = (values) => values.filter((v) => Number.isFinite(v))

// One stress session: error and empty rates, latency percentiles, how the
// turn-by-turn numbers drift, and where the context filled up.
export const scoreStress = (rows, { ctx, predict = 320 }) => {
  const ok = rows.filter((row) => !row.error && row.status === 200)
  const ttft = finite(ok.map((row) => row.stats?.ttft_ms))
  const tps = finite(ok.map((row) => row.stats?.tps))
  const total = finite(ok.map((row) => row.wall_ms))
  const prompt = ok.map((row) => [row.turn, row.usage?.prompt_tokens ?? null]).filter(([, y]) => y !== null)
  const ctxHit = rows.find((row) => (row.usage?.prompt_tokens ?? 0) >= ctx - predict || /context|overflow/i.test(row.error ?? ''))
  return {
    turns: rows.length,
    error_rate: rows.length ? rows.filter((row) => row.error || row.status !== 200).length / rows.length : null,
    empty_rate: rows.length ? rows.filter((row) => row.empty).length / rows.length : null,
    ttft_p50: percentile(ttft, 0.5),
    ttft_p95: percentile(ttft, 0.95),
    tps_p50: percentile(tps, 0.5),
    tps_p95: percentile(tps, 0.95),
    total_p50: percentile(total, 0.5),
    total_p95: percentile(total, 0.95),
    ttft_slope_ms_per_turn: slope(ok.map((row) => [row.turn, row.stats?.ttft_ms]).filter(([, y]) => Number.isFinite(y))),
    prompt_tokens_by_turn: prompt.map(([turn, tokens]) => ({ turn, tokens })),
    cached_tokens_by_turn: ok.map((row) => ({ turn: row.turn, tokens: row.usage?.prompt_tokens_details?.cached_tokens ?? null })),
    ctx_hit_turn: ctxHit ? { turn: ctxHit.turn, what: ctxHit.error ? 'error' : ctxHit.empty ? 'empty' : 'answered', prompt_tokens: ctxHit.usage?.prompt_tokens ?? null } : null,
  }
}

// Memory of the server tree during one session's generating phase, from the
// sampler rows labelled with the case: peak and slope over time (bytes per second).
export const memoryTrend = (hardwareRows) => {
  const rss = hardwareRows.map((row) => [row.t / 1000, row.rss_tree]).filter(([, y]) => Number.isFinite(y))
  const sys = hardwareRows.map((row) => [row.t / 1000, row.system_used]).filter(([, y]) => Number.isFinite(y))
  return {
    samples: hardwareRows.length,
    rss_tree_peak: rss.length ? Math.max(...rss.map(([, y]) => y)) : null,
    rss_tree_slope_bps: slope(rss),
    system_used_peak: sys.length ? Math.max(...sys.map(([, y]) => y)) : null,
    system_used_slope_bps: slope(sys),
  }
}
