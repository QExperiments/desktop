const emit = (write, obj, msg) => {
  if (msg === undefined) write(obj)
  else write(msg, obj)
}

export const logger = {
  info: (obj, msg) => emit(console.log, obj, msg),
  warn: (obj, msg) => emit(console.warn, obj, msg),
  error: (obj, msg) => emit(console.error, obj, msg),
}

export const logInfo = (log, obj, msg) => {
  if (typeof log?.info === 'function') log.info(obj, msg)
  else logger.info(obj, msg)
}

export const logWarn = (log, obj, msg) => {
  if (typeof log?.warn === 'function') log.warn(obj, msg)
  else logger.warn(obj, msg)
}

export const logError = (log, obj, msg) => {
  if (typeof log?.error === 'function') log.error(obj, msg)
  else logger.error(obj, msg)
}
