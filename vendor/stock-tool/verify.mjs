#!/usr/bin/env node
/**
 * Dependency-free self-test. Run with: node verify.mjs
 *
 * Covers query paths, the unknown-SKU case, JSON/mirror parity, and
 * immutability of the exported inventory. Does not throw from lookupStock.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import data from './src/inventory.data.js';
import { DATA_AS_OF, INVENTORY, listSkus, lookupStock } from './src/index.js';

const root = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  process.stderr.write(`FAIL: ${msg}\n`);
}

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const json = JSON.parse(readFileSync(path.join(root, 'data/inventory.json'), 'utf8'));

assert(DATA_AS_OF === '2026-06-30', 'DATA_AS_OF is 2026-06-30');
assert(Array.isArray(json) && json.length >= 30, `inventory.json has ~30 rows (got ${json.length})`);
assert(equal(json, data), 'inventory.json and src/inventory.data.js are identical');
assert(equal(json, INVENTORY), 'INVENTORY mirrors inventory.json');

assert(Object.isFrozen(INVENTORY), 'INVENTORY array is frozen');
assert(Object.isFrozen(INVENTORY[0]), 'INVENTORY rows are frozen');
let mutated = false;
try {
  INVENTORY.push({});
  mutated = true;
} catch {
  mutated = false;
}
assert(!mutated, 'INVENTORY.push throws');
mutated = false;
try {
  INVENTORY[0].onHand = -1;
  mutated = INVENTORY[0].onHand === -1;
} catch {
  mutated = false;
}
assert(!mutated, 'INVENTORY row mutation throws or is ignored');

for (const row of json) {
  assert(row.available === row.onHand - row.allocated, `${row.sku} ${row.region}: available = onHand - allocated`);
}

const skus = listSkus();
assert(skus.some((s) => s.sku === 'SD-X4-001'), 'listSkus includes SD-X4-001');
assert(skus.some((s) => s.sku === 'CL-GW-REV-C'), 'listSkus includes CL-GW-REV-C');
assert(
  equal(
    skus.map((s) => s.sku),
    [...skus.map((s) => s.sku)].sort((a, b) => a.localeCompare(b)),
  ),
  'listSkus is sorted by sku',
);

const americas = lookupStock({ sku: 'SD-X4-001', region: 'Americas' });
assert(americas.asOf === DATA_AS_OF, 'lookupStock returns asOf');
assert(americas.matchCount === 1, 'SD-X4-001 Americas is a single row');
assert(americas.matches[0].available === 22, 'SD-X4-001 Americas available is 22');
assert(americas.matches[0].unitListPrice === 48500, 'SD-X4-001 list price is 48500');
assert(americas.truncated === false, 'single-row result is not truncated');
assert(americas.suggestions.length === 0, 'hits do not include suggestions');

const origOnHand = INVENTORY.find((r) => r.sku === 'SD-X4-001' && r.region === 'Americas').onHand;
americas.matches[0].onHand = 0;
assert(
  INVENTORY.find((r) => r.sku === 'SD-X4-001' && r.region === 'Americas').onHand === origOnHand,
  'mutating a match does not mutate INVENTORY',
);

const again = lookupStock({ sku: 'SD-X4-001', region: 'Americas' });
assert(equal(lookupStock({ sku: 'SD-X4-001', region: 'Americas' }), again), 'lookupStock is deterministic');

const caseInsensitive = lookupStock({ sku: 'sd-x4-001', region: 'americas' });
assert(caseInsensitive.matchCount === 1, 'sku and region are case-insensitive');

const gwB = lookupStock({ sku: 'CL-GW-REV-B', region: 'Americas' });
assert(gwB.matches[0].available === 32, 'CL-GW-REV-B Americas available is 32');
assert(gwB.matches[0].unitListPrice === 6800, 'CL-GW-REV-B list price is 6800');

const revC = lookupStock({ sku: 'CL-GW-REV-C' });
assert(revC.matchCount === 3, 'CL-GW-REV-C has three regional rows');
assert(
  revC.matches.every((m) => m.status === 'quarantine' && m.leadTimeDays === 46 && m.unitListPrice === 7200),
  'CL-GW-REV-C is quarantine / 46-day lead / $7200',
);

const fanApac = lookupStock({ sku: 'SD-X4-FAN-01', region: 'APAC' });
assert(fanApac.matches[0].leadTimeDays === 18, 'APAC spare-parts lead time is 18');
const fanAm = lookupStock({ sku: 'SD-X4-FAN-01', region: 'Americas' });
assert(fanAm.matches[0].leadTimeDays === 12, 'Americas spare-parts lead time is 12');
const fanEmea = lookupStock({ sku: 'SD-X4-FAN-01', region: 'EMEA' });
assert(fanEmea.matches[0].leadTimeDays === 12, 'EMEA spare-parts lead time is 12');

const unknown = lookupStock({ sku: 'ZX-NO-SUCH-SKU' });
assert(unknown.matchCount === 0, 'unknown SKU matchCount is 0');
assert(unknown.matches.length === 0, 'unknown SKU matches is []');
assert(unknown.suggestions.length > 0, 'unknown SKU returns suggestions');
assert(unknown.asOf === DATA_AS_OF, 'unknown SKU still returns asOf');

let threw = false;
try {
  lookupStock({ sku: 'ZX-NO-SUCH-SKU' });
} catch {
  threw = true;
}
assert(!threw, 'unknown SKU does not throw');

const discHidden = lookupStock({ sku: 'CL-GW-REV-A' });
assert(discHidden.matchCount === 0, 'discontinued SKU is hidden by default');
assert(
  discHidden.suggestions.some((s) => s.sku === 'CL-GW-REV-A' && s.replacedBy === 'CL-GW-REV-B'),
  'discontinued SKU is suggested with replacedBy',
);

const discShown = lookupStock({ sku: 'CL-GW-REV-A', includeDiscontinued: true });
assert(discShown.matchCount === 1, 'includeDiscontinued returns rev A');
assert(discShown.matches[0].replacedBy === 'CL-GW-REV-B', 'rev A replacedBy is CL-GW-REV-B');

const query = lookupStock({ query: 'ServoDrive', region: 'Americas' });
assert(query.matchCount >= 1, 'query+region returns ServoDrive rows');
assert(
  query.matches.every((m) => m.region === 'Americas' && /servodrive/i.test(m.name + m.productLine)),
  'query+region filters both dimensions',
);

const all = lookupStock({});
assert(all.truncated === true, 'unfiltered lookup is truncated');
assert(all.matches.length === 25, 'truncated page size is 25');
assert(all.matchCount > 25, 'matchCount is the untruncated total');
assert(all.matches.every((m) => m.status !== 'discontinued'), 'default lookup omits discontinued');

const bogusRegion = lookupStock({ sku: 'SD-X4-001', region: 'Mars' });
assert(bogusRegion.matchCount === 0 && Array.isArray(bogusRegion.matches), 'unknown region returns empty, does not throw');

assert(!json.some((row) => /15 August|15 Aug/i.test(row.notes || '')), 'dataset does not leak the 15 August ship-hold date');

if (failed > 0) {
  process.stderr.write(`verify FAILED: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}
process.stdout.write(`verify: ${passed} passed\n`);
