export function logInfo(logger, obj, msg) {
  if (typeof logger?.info === 'function') logger.info(obj, msg)
  else console.log(msg, obj)
}

export function logWarn(logger, obj, msg) {
  if (typeof logger?.warn === 'function') logger.warn(obj, msg)
  else console.warn(msg, obj)
}
