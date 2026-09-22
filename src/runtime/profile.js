import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as sdk from '@qvac/sdk'
import { config } from '../config.js'
import { logger } from '../logger.js'

// I.6 -- the SDK profiler, wrapped so the rest of the runtime does not care
// whether it is on. Off unless MERIDIAN_PROFILE is set: `enable` hooks every
// SDK operation, and `verbose` also keeps a ring buffer of 1000 events.
//
// Two blocks are what we are after, both of which our own instrumentation
// cannot produce:
//   phases   -- what a single operation is made of. A local check measured
//               loadModel at 722 ms of which 353 ms is sha256 validation, and
//               completionStream at 78.3 ms of which 67 ms is model execution,
//               so 11 ms is what the JS abstraction costs.
//   resources-- memory and GPU sampled at the moment of generation. The eval
//               sampler reads RSS, which undercounts a Metal backend.
// Resource gauges are off in the SDK's own defaults, so we ask for them.

// Aggregate keys the SDK reports in tokens, bytes or a rate rather than in
// milliseconds; everything else in `aggregates` is a duration. Without this
// `embed.tokensPerSecond` reads as an operation that took 617 647 ms.
const NOT_MS = /tokens|bytes|count|persecond|tps|_per_/i

export const createProfile = ({ mode = config.profile, dir = config.profileDir, log = logger } = {}) => {
  const enabled = mode === 'summary' || mode === 'verbose'
  if (enabled) {
    sdk.profiler.enable({
      mode,
      includeServerBreakdown: true,
      includeResourceGauges: true,
    })
    log.info({ mode }, 'profiler enabled')
  }

  // The export as the SDK gives it, plus the two readings we care about pulled
  // to the top so a reader does not have to know the key names.
  const snapshot = () => {
    if (!enabled) return null
    const exported = sdk.profiler.exportJSON({ includeRecentEvents: mode === 'verbose' })
    const aggregates = exported.aggregates ?? {}
    const phases = Object.entries(aggregates)
      .filter(([key]) => !NOT_MS.test(key))
      .map(([key, stats]) => ({ key, count: stats.count, avg_ms: round(stats.avg), min_ms: round(stats.min), max_ms: round(stats.max), total_ms: round(stats.sum) }))
      .sort((a, b) => b.total_ms - a.total_ms)
    return { ...exported, phases, resources: resourcesOf(exported.recentEvents) }
  }

  // Written on shutdown so a run leaves its numbers behind without anyone
  // having to remember to curl the endpoint first.
  const dump = async () => {
    const data = snapshot()
    if (!data) return null
    const path = join(dir, `profile-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    await mkdir(dir, { recursive: true })
    await writeFile(path, JSON.stringify(data, null, 2))
    log.info({ path, phases: data.phases.length }, 'profile written')
    return path
  }

  return { enabled, mode, snapshot, dump, table: () => (enabled ? sdk.profiler.exportTable() : null) }
}

const round = (value) => (Number.isFinite(value) ? Number(value.toFixed(1)) : null)

// Every reading in a gauge is wrapped as { status, value, provenance }, and a
// status other than `supported` means the platform could not answer -- GPU
// memory on Metal comes back `unverified`. Unwrap to the number or to null;
// never to a zero that would read as a measurement.
const valueOf = (field) => (field && field.status === 'supported' && Number.isFinite(field.value) ? field.value : null)
// The GPU gauge wraps a list, not a number, so it needs its own unwrap.
const listOf = (field) => (field && field.status === 'supported' && Array.isArray(field.value) ? field.value : [])
const mean = (values) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null)
const peak = (values) => (values.length ? Math.max(...values) : null)

// Memory, CPU and GPU at the moments the SDK sampled them. Only `verbose`
// carries the events these come from; in `summary` the field is null, not an
// empty reading, so a report cannot mistake "not recorded" for "nothing used".
export const resourcesOf = (events) => {
  if (!Array.isArray(events)) return null
  const gauges = events.map((event) => event.resources).filter(Boolean)
  if (!gauges.length) return null
  const used = gauges.map((gauge) => valueOf(gauge.memory?.usedBytes)).filter(Number.isFinite)
  const total = gauges.map((gauge) => valueOf(gauge.memory?.totalBytes)).filter(Number.isFinite)
  const cpu = gauges.map((gauge) => valueOf(gauge.cpu)).filter(Number.isFinite)
  const gpu = gauges.flatMap((gauge) => listOf(gauge.gpus).map((entry) => valueOf(entry.compute))).filter(Number.isFinite)
  return {
    samples: gauges.length,
    origins: [...new Set(gauges.map((gauge) => gauge.origin))],
    memory_used_peak: peak(used),
    memory_used_mean: mean(used),
    memory_total: peak(total),
    cpu_peak: peak(cpu),
    gpu_compute_peak: peak(gpu),
  }
}
