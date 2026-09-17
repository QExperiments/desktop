/**
 * meridian-stock-tool — deterministic inventory lookup.
 *
 * No filesystem, no JSON import attributes, no Date.now(), no randomness.
 * Returns structured JSON only. Unknown SKUs return empty matches plus
 * suggestions and do not throw.
 */

import inventoryRows from './inventory.data.js';

export const DATA_AS_OF = '2026-06-30';

const MAX_MATCHES = 25;
const MAX_SUGGESTIONS = 3;
const REGIONS = ['Americas', 'EMEA', 'APAC'];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    if (Array.isArray(value)) {
      for (const item of value) deepFreeze(item);
    } else {
      for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
  }
  return value;
}

function cloneRecord(row) {
  return {
    sku: row.sku,
    name: row.name,
    productLine: row.productLine,
    revision: row.revision,
    region: row.region,
    warehouse: row.warehouse,
    onHand: row.onHand,
    allocated: row.allocated,
    available: row.available,
    leadTimeDays: row.leadTimeDays,
    status: row.status,
    replacedBy: row.replacedBy,
    unitListPrice: row.unitListPrice,
    notes: row.notes,
  };
}

function norm(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function compareRows(a, b) {
  const sku = a.sku.localeCompare(b.sku);
  if (sku !== 0) return sku;
  return a.region.localeCompare(b.region);
}

function haystack(row) {
  return [row.sku, row.name, row.productLine, row.revision, row.warehouse, row.notes]
    .filter((v) => v != null && v !== '')
    .join(' ')
    .toLowerCase();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function uniqueSkus(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (!seen.has(row.sku)) {
      seen.set(row.sku, {
        sku: row.sku,
        name: row.name,
        productLine: row.productLine,
        revision: row.revision,
        status: row.status,
        replacedBy: row.replacedBy,
      });
    }
  }
  return seen;
}

function suggest(needle, catalogue) {
  const q = norm(needle);
  if (!q) return [];
  const scored = [];
  for (const item of catalogue.values()) {
    const skuL = item.sku.toLowerCase();
    const nameL = item.name.toLowerCase();
    let score = Math.min(levenshtein(q, skuL), levenshtein(q, nameL));
    if (skuL.includes(q) || nameL.includes(q) || q.includes(skuL)) score = Math.min(score, 0);
    scored.push({ score, item });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.item.sku.localeCompare(b.item.sku);
  });
  return scored.slice(0, MAX_SUGGESTIONS).map(({ item }) => ({
    sku: item.sku,
    name: item.name,
    productLine: item.productLine,
    status: item.status,
    replacedBy: item.replacedBy,
  }));
}

const ROWS = inventoryRows.map(cloneRecord);
export const INVENTORY = deepFreeze(ROWS.map(cloneRecord));

const CATALOGUE = uniqueSkus(ROWS);

/**
 * Lightweight SKU catalogue, suitable for Zod enums / tool descriptions.
 * Includes discontinued SKUs. Sorted by sku.
 */
export function listSkus() {
  return [...CATALOGUE.values()]
    .map((item) => ({
      sku: item.sku,
      name: item.name,
      productLine: item.productLine,
      revision: item.revision,
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
}

/**
 * Query frozen inventory.
 *
 * @param {object} [args]
 * @param {string} [args.sku] Exact SKU (case-insensitive). Unknown SKUs do not throw.
 * @param {string} [args.query] Substring match against sku, name, product line, warehouse, notes.
 * @param {string} [args.region] Americas | EMEA | APAC (case-insensitive).
 * @param {boolean} [args.includeDiscontinued=false]
 * @returns {{ asOf: string, matchCount: number, truncated: boolean, matches: object[], suggestions: object[] }}
 */
export function lookupStock(args = {}) {
  const input = args && typeof args === 'object' ? args : {};
  const sku = typeof input.sku === 'string' ? input.sku.trim() : '';
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const regionRaw = typeof input.region === 'string' ? input.region.trim() : '';
  const includeDiscontinued = input.includeDiscontinued === true;

  const skuL = norm(sku);
  const queryL = norm(query);
  const regionL = norm(regionRaw);
  const regionKnown = !regionL || REGIONS.some((r) => r.toLowerCase() === regionL);

  let rows = ROWS.slice();

  if (skuL) {
    rows = rows.filter((row) => row.sku.toLowerCase() === skuL);
  }
  if (queryL) {
    rows = rows.filter((row) => haystack(row).includes(queryL));
  }
  if (regionL) {
    rows = regionKnown ? rows.filter((row) => row.region.toLowerCase() === regionL) : [];
  }
  if (!includeDiscontinued) {
    rows = rows.filter((row) => row.status !== 'discontinued');
  }

  rows.sort(compareRows);

  const matchCount = rows.length;
  const truncated = matchCount > MAX_MATCHES;
  const matches = rows.slice(0, MAX_MATCHES).map(cloneRecord);

  let suggestions = [];
  if (matchCount === 0) {
    const needle = sku || query || regionRaw;
    suggestions = suggest(needle, CATALOGUE);
    if (skuL && CATALOGUE.has(sku)) {
      const hit = CATALOGUE.get(sku);
      const head = {
        sku: hit.sku,
        name: hit.name,
        productLine: hit.productLine,
        status: hit.status,
        replacedBy: hit.replacedBy,
      };
      suggestions = [head, ...suggestions.filter((s) => s.sku !== hit.sku)].slice(0, MAX_SUGGESTIONS);
    } else if (skuL) {
      const byLower = [...CATALOGUE.values()].find((item) => item.sku.toLowerCase() === skuL);
      if (byLower) {
        const head = {
          sku: byLower.sku,
          name: byLower.name,
          productLine: byLower.productLine,
          status: byLower.status,
          replacedBy: byLower.replacedBy,
        };
        suggestions = [head, ...suggestions.filter((s) => s.sku !== byLower.sku)].slice(
          0,
          MAX_SUGGESTIONS,
        );
      }
    }
  }

  return {
    asOf: DATA_AS_OF,
    matchCount,
    truncated,
    matches,
    suggestions,
  };
}
