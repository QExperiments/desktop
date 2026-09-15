// One registry for every long call: model loads, asset downloads, inference (1.4).
// `cancel` is injected so this module stays free of the SDK.
export const createCancelRegistry = ({ cancel }) => {
  const inflight = new Map()

  const add = (requestId, meta) => {
    inflight.set(requestId, { requestId, startedAt: Date.now(), ...meta })
    return requestId
  }

  const drop = (requestId) => inflight.delete(requestId)

  // For SDK calls that return a decorated promise exposing requestId up front.
  const run = async (meta, start) => {
    const op = start()
    add(op.requestId, meta)
    try {
      return await op
    } finally {
      drop(op.requestId)
    }
  }

  const stop = async (requestId, { clearCache = false } = {}) => {
    const entry = inflight.get(requestId)
    if (!entry) return null
    if (entry.abort) entry.abort()
    else await cancel({ requestId, ...(clearCache ? { clearCache } : {}) })
    return entry
  }

  const stopAll = async (options) => {
    const ids = [...inflight.keys()]
    await Promise.allSettled(ids.map((id) => stop(id, options)))
    return ids.length
  }

  return { add, drop, run, stop, stopAll, list: () => [...inflight.values()] }
}
