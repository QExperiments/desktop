// The TTS engine hands back 16-bit PCM samples. Whisper, browsers and the
// OpenAI audio contract all want them inside a RIFF container.
export const pcmToWav = (samples, sampleRate) => {
  const data = Buffer.alloc(samples.length * 2)
  for (const [index, sample] of samples.entries()) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), index * 2)
  }

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)

  return Buffer.concat([header, data])
}

// The streaming transcription session takes float samples, while microphones,
// browsers and our own WAV replies all speak 16-bit PCM.
export const wavToFloat32 = (wav) => {
  if (wav.toString('latin1', 0, 4) !== 'RIFF') throw new Error('not a RIFF/WAVE file')
  let at = 12
  let sampleRate = 0

  while (at + 8 <= wav.length) {
    const id = wav.toString('latin1', at, at + 4)
    const size = wav.readUInt32LE(at + 4)
    if (id === 'fmt ') sampleRate = wav.readUInt32LE(at + 12)
    if (id === 'data') {
      const samples = new Float32Array(size / 2)
      for (let index = 0; index < samples.length; index += 1) samples[index] = wav.readInt16LE(at + 8 + index * 2) / 32768
      return { samples, sampleRate }
    }
    at += 8 + size + (size % 2)
  }

  throw new Error('no data chunk in the WAV file')
}
