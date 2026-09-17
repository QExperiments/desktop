// Provisioning step (req 1.2). Runs with the network up; `serve` never does.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'
import { config } from '../src/config.js'
import { logger } from '../src/logger.js'
import { createCancelRegistry } from '../src/runtime/cancel.js'
import { selectTier } from '../src/runtime/capability.js'
import { catalog, findCached, key, readManifest, sizeOf, targetsFor, writeManifest } from '../src/runtime/models.js'
import * as sdk from '@qvac/sdk'

const { values: flags } = parseArgs({
  options: {
    tier: { type: 'string' },
    role: { type: 'string', multiple: true },
    source: { type: 'string', default: 'registry' },
    'from-dir': { type: 'string' },
    all: { type: 'boolean', default: false },
    discard: { type: 'boolean', default: false },
  },
})

const registry = createCancelRegistry({ cancel: sdk.cancel })

const sha256 = async (path) => {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

const verify = async (path, target) => {
  const actual = await sha256(path)
  if (actual !== target.sha256) {
    await rm(path, { force: true })
    throw new Error(`${target.file}: checksum mismatch, expected ${target.sha256} got ${actual}`)
  }
}

// Source 1: the QVAC distributed registry. The SDK checks the catalog checksum
// itself and keeps the partial file when a download is cancelled.
const fromRegistry = async (target) => {
  const descriptor = sdk[target.constant]
  if (!descriptor) throw new Error(`${target.constant} is not in the @qvac/sdk catalog`)
  const assetSrc = await registry.run({ kind: 'download', role: target.role, source: 'registry' }, () =>
    sdk.downloadAsset({ assetSrc: descriptor, onProgress: progress(target) }))
  const path = await findCached(config.cacheDir, target.file)
  if (!path) throw new Error(`${target.file} is not in ${config.cacheDir} after downloadAsset`)
  return { path, assetSrc, source: 'registry' }
}

// Source 2: plain HTTPS against the upstream HuggingFace file, resumed with a
// Range request when a previous run was cancelled part way.
const fromHttps = async (target) => {
  if (!target.https) throw new Error(`${target.constant} has no HTTPS mirror; use --source registry`)
  const path = join(config.modelsDir, 'https', target.file)
  const part = `${path}.part`
  await mkdir(dirname(path), { recursive: true })

  if ((await sizeOf(path)) !== target.bytes) {
    const done = await sizeOf(part)
    const controller = new AbortController()
    const requestId = registry.add(randomUUID(), { kind: 'download', role: target.role, source: 'https', abort: () => controller.abort() })
    try {
      const response = await fetch(target.https, { signal: controller.signal, headers: done ? { range: `bytes=${done}-` } : {} })
      if (!response.ok) throw new Error(`${target.https} answered ${response.status}`)
      const resumed = response.status === 206
      logger.info({ role: target.role, bytes: target.bytes, resumedFrom: resumed ? done : 0 }, 'downloading over https')
      await pipeline(Readable.fromWeb(response.body), createWriteStream(part, { flags: resumed ? 'a' : 'w' }))
      await rename(part, path)
    } finally {
      registry.drop(requestId)
    }
  }

  await verify(path, target)
  return { path, source: 'https' }
}

// Source 3: a directory the MDM pipeline already placed on the machine.
const fromDir = async (target) => {
  const dir = flags['from-dir'] || config.importDir
  if (!dir) throw new Error('--source fs needs --from-dir or MERIDIAN_MODELS_DIR')
  const path = resolve(dir, target.file)
  if ((await sizeOf(path)) !== target.bytes) throw new Error(`${path} is missing or has the wrong size`)
  await verify(path, target)
  return { path, source: 'fs' }
}

const sources = { registry: fromRegistry, https: fromHttps, fs: fromDir }

const progress = (target) => {
  let last = -1
  return ({ percentage = 0 }) => {
    const step = Math.floor(percentage / 10) * 10
    if (step <= last) return
    last = step
    logger.info({ role: target.role, constant: target.constant, percentage: step }, 'downloading from the registry')
  }
}

const stopping = async (code) => {
  const count = await registry.stopAll({ clearCache: flags.discard })
  logger.warn({ cancelled: count, discarded: flags.discard }, 'cancelled; rerun models:fetch to resume')
  await sdk.close()
  process.exit(code)
}
process.on('SIGINT', () => stopping(130))
process.on('SIGTERM', () => stopping(143))

const fetchAll = async () => {
  const fetchOne = sources[flags.source]
  if (!fetchOne) throw new Error(`--source must be one of ${Object.keys(sources).join(', ')}`)

  const chosen = flags.tier
    ? { tier: flags.tier.toUpperCase(), reason: 'passed with --tier' }
    : selectTier(await sdk.getSystemResources({ sample: true }), { ...catalog, override: config.tierOverride })
  if (!chosen.tier) throw new Error(`${chosen.reason}; pass --tier S to fetch the smallest set anyway`)

  const wanted = flags.role ?? []
  const targets = targetsFor(chosen.tier, { optional: flags.all || wanted.length > 0 })
    .filter((target) => wanted.length === 0 || wanted.includes(target.role))
  if (!targets.length) throw new Error(`no models defined for tier ${chosen.tier}`)
  logger.info({ tier: chosen.tier, reason: chosen.reason, roles: targets.map((target) => target.role) }, 'fetching weights')

  const previous = await readManifest(config.manifestPath)
  const entries = { ...previous?.entries }

  for (const target of targets) {
    const known = entries[key(target.role, target.tier)]
    if (known?.constant === target.constant && (await sizeOf(known.path)) === target.bytes) {
      logger.info({ role: target.role, path: known.path }, 'already provisioned, skipping')
      continue
    }
    const { path, source, assetSrc = null } = await fetchOne(target)
    entries[key(target.role, target.tier)] = {
      role: target.role, tier: target.tier, constant: target.constant, modelType: target.modelType,
      source, path, assetSrc, bytes: target.bytes, sha256: target.sha256, fetchedAt: new Date().toISOString(),
    }
    logger.info({ role: target.role, source, path, bytes: target.bytes, sha256: target.sha256 }, 'provisioned')
  }

  await writeManifest(config.manifestPath, { version: 1, tier: chosen.tier, updatedAt: new Date().toISOString(), entries })
  logger.info({ manifest: config.manifestPath, tier: chosen.tier }, 'models:fetch done')
}

try {
  await fetchAll()
  await sdk.close()
} catch (error) {
  logger.error({ err: error.message }, 'models:fetch failed')
  await sdk.close()
  process.exit(1)
}
