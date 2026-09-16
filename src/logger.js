const emit = (level, stream) => (obj, msg) => {
  const [fields, text] = typeof obj === 'string' ? [{}, obj] : [obj, msg]
  stream.write(`${JSON.stringify({ level, time: new Date().toISOString(), ...fields, msg: text })}\n`)
}

export const logger = {
  info: emit('info', process.stdout),
  warn: emit('warn', process.stderr),
  error: emit('error', process.stderr),
}
