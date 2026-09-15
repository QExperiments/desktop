// Manifest and catalog lookups. No SDK import: see capability.js for why.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import catalog from '../../models.json' with { type: 'json' }

export { catalog }

export const key = (role, tier) => `${role}:${tier}`

export const targetsFor = (tier, { optional = false } = {}) =>
  Object.entries(catalog.roles)
    .filter(([, role]) => (optional || role.required) && role.models[tier])
    .map(([name, role]) => ({ role: name, tier, modelType: role.modelType, resident: role.resident === true, ...role.models[tier] }))

export const readManifest = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export const writeManifest = async (path, manifest) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

export const sizeOf = async (path) => stat(path).then((info) => info.size, () => 0)

// The SDK stores a catalog download as `<hash>_<file>` in its cache. Finding it
// by name is how a provisioned weight is confirmed present without a network call.
export const findCached = async (cacheDir, file) => {
  const names = await readdir(cacheDir).catch(() => [])
  const match = names.find((name) => name === file || name.endsWith(`_${file}`))
  return match ? join(cacheDir, match) : null
}

export const entryFor = (manifest, role, tier) => manifest?.entries?.[key(role, tier)] ?? null

// serve() calls this before loading anything, so a missing weight is a clear
// error instead of a silent download while the network is supposed to be off.
export const missingFrom = (manifest, targets) =>
  targets.filter((target) => !entryFor(manifest, target.role, target.tier)).map((target) => key(target.role, target.tier))

const provisioned = async (manifest, tier) => {
  const targets = targetsFor(tier)
  if (!targets.length) return false
  const checks = await Promise.all(targets.map(async (target) => {
    const entry = entryFor(manifest, target.role, tier)
    return Boolean(entry) && (await sizeOf(entry.path)) === entry.bytes
  }))
  return checks.every(Boolean)
}

// The tier we serve: the one this machine deserves if its weights are all
// there, otherwise the largest one that is. Returns null when nothing is.
export const provisionedTier = async (manifest, preferred, order = ['L', 'M', 'S']) => {
  for (const tier of [preferred, ...order]) {
    if (await provisioned(manifest, tier)) return tier
  }
  return null
}
