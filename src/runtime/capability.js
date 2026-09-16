// Pure tier selection. No SDK import: unit tests and CI run without native addons.
const TIERS = ['L', 'M', 'S']
const val = (metric) => (metric?.status === 'supported' ? metric.value : undefined)
const driver = (gpus, name) => gpus.some((gpu) => val(gpu.drivers?.[name]) === true)

export const readHardware = (resources) => {
  const gpus = val(resources?.capabilities?.gpus) ?? []
  const backend = ['metal', 'cuda', 'vulkan', 'opencl'].find((name) => driver(gpus, name)) ?? 'cpu'

  return {
    totalBytes: val(resources?.capabilities?.memory?.totalBytes) ?? null,
    cpu: val(val(resources?.capabilities?.cpu)?.name) ?? null,
    gpu: val(gpus[0]?.name) ?? null,
    backend,
    // Integrated graphics borrow system RAM, so the model budget is not extended by them.
    dedicatedGpu: gpus.some((gpu) => val(gpu.unifiedMemory) === false),
  }
}

// Free RAM is not used: macOS counts cached pages as used, which would drop a
// 24 GB Mac to the smallest tier. Total RAM minus a fixed OS reserve is stable
// across platforms and matches how the fleet was sized.
export const selectTier = (resources, { tiers, osReserveBytes, override = '' } = {}) => {
  const hardware = readHardware(resources)
  const budgetBytes = hardware.totalBytes === null ? null : Math.max(0, hardware.totalBytes - osReserveBytes)

  if (override) {
    if (!tiers[override]) throw new Error(`MERIDIAN_TIER=${override} is not one of ${Object.keys(tiers).join(', ')}`)
    return { tier: override, budgetBytes, hardware, reason: 'forced by MERIDIAN_TIER' }
  }

  if (budgetBytes === null) return { tier: 'S', budgetBytes, hardware, reason: 'total RAM unknown, assuming the smallest tier' }

  const tier = TIERS.find((name) => budgetBytes >= tiers[name].minBudgetBytes) ?? 'S'
  const gib = (n) => `${(n / 1024 ** 3).toFixed(1)} GiB`

  return {
    tier,
    budgetBytes,
    hardware,
    reason: `${gib(hardware.totalBytes)} RAM leaves ${gib(budgetBytes)} for models on ${hardware.backend}`,
  }
}
