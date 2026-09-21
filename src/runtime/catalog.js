// One read-only view of the model catalog, for `npm run models:list` and
// GET /v1/models/catalog: every role and tier of models.json, whether its
// weights are provisioned (manifest.json), what the QVAC registry knew about
// it the last time `models:list --refresh` ran with the network up
// (registry.json), and which tiers this machine's RAM budget affords. Pure
// over JSON, no SDK import: nothing here downloads or loads a model.
import { readFile } from 'node:fs/promises'
import { entryFor, sizeOf } from './models.js'

export const readRegistry = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// What of a registry entry is worth keeping on disk: enough to match a
// models.json entry by checksum and to compare its size. The blob keys and
// offsets the SDK uses to fetch stay out; fetching is models-fetch's job.
export const registrySnapshot = (entries, now = new Date()) => ({
  version: 1,
  updatedAt: now.toISOString(),
  count: entries.length,
  models: entries.map(({ name, modelId, addon, engine, expectedSize, sha256Checksum, quantization, params, registrySource }) =>
    ({ name, modelId, addon, engine, expectedSize, sha256Checksum, quantization, params, registrySource })),
})

export const buildCatalog = async ({ catalog, manifest, registry, tier, budgetBytes }) => {
  const budget = Number.isFinite(budgetBytes) ? budgetBytes : null
  const bySha = new Map((registry?.models ?? []).map((model) => [model.sha256Checksum, model]))

  const tiers = Object.entries(catalog.tiers).map(([name, spec]) => ({
    tier: name,
    label: spec.label,
    minBudgetBytes: spec.minBudgetBytes,
    // What the resident pair weighs on this tier; the rest loads on demand.
    residentBytes: Object.values(catalog.roles).filter((role) => role.resident && role.models[name]).reduce((sum, role) => sum + role.models[name].bytes, 0),
    withinBudget: budget === null ? null : budget >= spec.minBudgetBytes,
    serving: name === tier,
  }))
  const withinBudget = Object.fromEntries(tiers.map((t) => [t.tier, t.withinBudget]))

  const roles = []
  for (const [role, spec] of Object.entries(catalog.roles)) {
    const models = []
    for (const [name, model] of Object.entries(spec.models)) {
      const entry = entryFor(manifest, role, name)
      const provisioned = entry ? (await sizeOf(entry.path)) === entry.bytes : false
      const known = bySha.get(model.sha256) ?? null
      models.push({
        tier: name,
        constant: model.constant,
        file: model.file,
        bytes: model.bytes,
        sha256: model.sha256,
        https: model.https ?? null,
        ctx: model.modelConfig?.ctx_size ?? spec.modelConfig?.ctx_size ?? null,
        provisioned,
        source: provisioned ? entry.source : null,
        path: provisioned ? entry.path : null,
        fetchedAt: provisioned ? entry.fetchedAt ?? null : null,
        // null until `models:list --refresh` has written a registry snapshot.
        registry: registry
          ? known
            ? { found: true, sizeMatches: known.expectedSize === model.bytes, quantization: known.quantization ?? null, params: known.params ?? null }
            : { found: false }
          : null,
        withinBudget: withinBudget[name] ?? null,
        serving: name === tier,
      })
    }
    roles.push({ role, addon: spec.addon, required: spec.required === true, resident: spec.resident === true, models })
  }

  return {
    tier: tier ?? null,
    budgetBytes: budget,
    osReserveBytes: catalog.osReserveBytes,
    registry: registry ? { updatedAt: registry.updatedAt, count: registry.count } : null,
    tiers,
    roles,
  }
}
