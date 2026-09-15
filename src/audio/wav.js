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
