import {
  LLAMA_3_2_1B_INST_Q4_0,
  QWEN3_4B_INST_Q4_K_M,
  QWEN3_600M_INST_Q4,
} from '@qvac/sdk'
import { GiB } from './config.js'

function metricValue(metric) {
  return metric?.status === 'supported' ? metric.value : undefined
}

function ramBytes(resources) {
  return metricValue(resources?.capabilities?.memory?.totalBytes)
}

function hasDedicatedGpu(resources) {
  const gpus = metricValue(resources?.capabilities?.gpus)
  if (!Array.isArray(gpus)) return false
  return gpus.some((gpu) => metricValue(gpu.unifiedMemory) === false)
}

export function describeResources(resources) {
  const bytes = ramBytes(resources)
  return {
    ramGiB: bytes != null ? Number((bytes / GiB).toFixed(2)) : null,
    dedicatedGpu: hasDedicatedGpu(resources),
  }
}

/**
 * Pick a chat GGUF that can actually run on this device (Req 5.2).
 * 8 GB + iGPU (2019 laptop) stays on 0.6B Q4; a stronger box can take 4B.
 */
export function selectModel(resources, { assumeStrongPeer = false } = {}) {
  if (assumeStrongPeer) {
    return {
      id: 'QWEN3_4B_INST_Q4_K_M',
      modelSrc: QWEN3_4B_INST_Q4_K_M,
      reason: 'peer assumed stronger than the local terminal',
    }
  }

  const bytes = ramBytes(resources)
  const dedicatedGpu = hasDedicatedGpu(resources)
  const ramGiB = bytes != null ? bytes / GiB : null

  if (ramGiB != null && ramGiB <= 8.5 && !dedicatedGpu) {
    return {
      id: 'QWEN3_600M_INST_Q4',
      modelSrc: QWEN3_600M_INST_Q4,
      reason: `local RAM ${ramGiB.toFixed(1)} GiB, integrated graphics`,
    }
  }

  if (dedicatedGpu && ramGiB != null && ramGiB >= 16) {
    return {
      id: 'QWEN3_4B_INST_Q4_K_M',
      modelSrc: QWEN3_4B_INST_Q4_K_M,
      reason: `local RAM ${ramGiB.toFixed(1)} GiB with dedicated GPU`,
    }
  }

  return {
    id: 'LLAMA_3_2_1B_INST_Q4_0',
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    reason:
      ramGiB != null
        ? `local RAM ${ramGiB.toFixed(1)} GiB`
        : 'RAM unknown; conservative 1B Q4',
  }
}
