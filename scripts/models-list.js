// `npm run models:list`: the model catalog as this machine sees it, with no
// network: models.json against the manifest and the RAM budget. With
// --refresh it first asks the QVAC registry what it knows and writes
// data/models/registry.json; `serve` only ever reads that file (ADR-002).
//   npm run models:list                  # table
//   npm run models:list -- --refresh     # ask the registry first (network)
//   npm run models:list -- --tier S      # budget column for another tier
//   npm run models:list -- --json        # the same object GET /v1/models/catalog returns
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import * as sdk from '@qvac/sdk'
import { config } from '../src/config.js'
import { selectTier } from '../src/runtime/capability.js'
import { buildCatalog, readRegistry, registrySnapshot } from '../src/runtime/catalog.js'
import { catalog, readManifest } from '../src/runtime/models.js'

const { values: flags } = parseArgs({
  options: {
    refresh: { type: 'boolean', default: false },
    tier: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
})

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`
const mark = (value) => (value === true ? 'yes' : value === false ? 'no' : '-')

const main = async () => {
  if (flags.refresh) {
    const entries = await sdk.modelRegistryList()
    const snapshot = registrySnapshot(entries)
    await mkdir(dirname(config.registryPath), { recursive: true })
    await writeFile(config.registryPath, `${JSON.stringify(snapshot, null, 2)}\n`)
    console.error(`registry: ${snapshot.count} models listed, written to ${config.registryPath}`)
  }

  const chosen = flags.tier
    ? { tier: flags.tier.toUpperCase(), budgetBytes: null, reason: 'passed with --tier' }
    : selectTier(await sdk.getSystemResources({ sample: true }), { ...catalog, override: config.tierOverride })
  const view = await buildCatalog({
    catalog,
    manifest: await readManifest(config.manifestPath),
    registry: await readRegistry(config.registryPath),
    tier: chosen.tier,
    budgetBytes: chosen.budgetBytes,
  })

  if (flags.json) {
    console.log(JSON.stringify(view, null, 2))
    return
  }

  console.log(`tier ${view.tier ?? '?'}${view.budgetBytes !== null ? `, budget ${gb(view.budgetBytes)} (RAM minus ${gb(view.osReserveBytes)})` : ''}; ${chosen.reason}`)
  console.log(view.registry ? `registry snapshot: ${view.registry.count} models, ${view.registry.updatedAt}` : 'registry snapshot: none (run with --refresh while online)')
  console.log('tiers: ' + view.tiers.map((t) => `${t.tier}${t.serving ? '*' : ''} resident ${gb(t.residentBytes)}, budget ${mark(t.withinBudget)}`).join(' | '))
  console.log()

  const rows = view.roles.flatMap((role) => role.models.map((m) => [
    role.role + (role.resident ? ' (resident)' : ''), m.tier + (m.serving ? '*' : ''), m.constant, gb(m.bytes),
    m.provisioned ? `yes (${m.source})` : 'no', m.registry ? (m.registry.found ? (m.registry.sizeMatches ? 'yes' : 'size differs') : 'not found') : '-', mark(m.withinBudget),
  ]))
  const headers = ['role', 'tier', 'constant', 'size', 'provisioned', 'in registry', 'fits budget']
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  console.log(line(headers))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const row of rows) console.log(line(row))
  console.log('\n* = the tier this machine serves. Nothing here downloads; `npm run models:fetch` does.')
}

try {
  await main()
  await sdk.close()
} catch (error) {
  console.error(`models:list failed: ${error.message}`)
  await sdk.close()
  process.exit(1)
}
