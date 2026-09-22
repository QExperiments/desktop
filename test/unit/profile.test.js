import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProfile, resourcesOf } from '../../src/runtime/profile.js'

test('profiling stays off unless a mode is asked for', async () => {
  const off = createProfile({ mode: '', log: { info() {}, warn() {} } })
  assert.equal(off.enabled, false)
  // No mode means no reading at all, not a reading of zero: a report must not
  // be able to mistake "not recorded" for "nothing used".
  assert.equal(off.snapshot(), null)
  assert.equal(off.table(), null)
  assert.equal(await off.dump(), null)
})

test('resourcesOf reads memory and GPU out of the recorded events', () => {
  // Every reading arrives as { status, value, provenance }; GPU memory on a
  // Metal backend comes back `unverified` and must read as null, not as 0.
  const ok = (value) => ({ status: 'supported', value })
  const events = [
    { resources: { origin: 'local', cpu: ok(0.4), memory: { usedBytes: ok(2_000_000_000), totalBytes: ok(8_000_000_000) }, gpus: ok([{ compute: ok(40), memoryUsedBytes: { status: 'unverified' } }]) } },
    { resources: { origin: 'local', cpu: ok(0.9), memory: { usedBytes: ok(2_400_000_000), totalBytes: ok(8_000_000_000) }, gpus: ok([{ compute: ok(95) }]) } },
    { ms: 12 },
  ]
  const read = resourcesOf(events)
  assert.equal(read.samples, 2)
  assert.deepEqual(read.origins, ['local'])
  assert.equal(read.memory_used_peak, 2_400_000_000)
  assert.equal(read.memory_used_mean, 2_200_000_000)
  assert.equal(read.memory_total, 8_000_000_000)
  assert.equal(read.cpu_peak, 0.9)
  assert.equal(read.gpu_compute_peak, 95)
})

test('a reading the platform could not answer is null, never zero', () => {
  const read = resourcesOf([{ resources: { origin: 'local', memory: { usedBytes: { status: 'unverified', reason: 'scope is unverified' } }, gpus: { status: 'unsupported' } } }])
  assert.equal(read.samples, 1)
  assert.equal(read.memory_used_peak, null)
  assert.equal(read.gpu_compute_peak, null)
})

test('resourcesOf is null when nothing carried a gauge', () => {
  // `summary` records no events, so the field must say "not recorded".
  assert.equal(resourcesOf(undefined), null)
  assert.equal(resourcesOf([]), null)
  assert.equal(resourcesOf([{ ms: 3 }, { ms: 4 }]), null)
})

test('a delegated run is visible in the origins of the gauges', () => {
  // req 1.1 asks that inference stays on the device or on a peer Meridian
  // controls; this is the reading that says which of the two happened.
  const read = resourcesOf([
    { resources: { origin: 'local', memory: { usedBytes: { status: 'supported', value: 1 } } } },
    { resources: { origin: 'provider', memory: { usedBytes: { status: 'supported', value: 2 } } } },
  ])
  assert.deepEqual(read.origins.sort(), ['local', 'provider'])
})
