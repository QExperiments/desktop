import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pcmToWav, wavToFloat32 } from '../../src/audio/wav.js'

describe('pcmToWav', () => {
  it('writes a mono 16-bit header the SDK and browsers both accept', () => {
    const wav = pcmToWav([0, 1000, -1000], 24_000)
    assert.equal(wav.toString('latin1', 0, 4), 'RIFF')
    assert.equal(wav.toString('latin1', 8, 12), 'WAVE')
    assert.equal(wav.readUInt16LE(22), 1, 'channels')
    assert.equal(wav.readUInt32LE(24), 24_000, 'sample rate')
    assert.equal(wav.readUInt16LE(34), 16, 'bits per sample')
    assert.equal(wav.length, 44 + 6)
  })

  it('clamps instead of wrapping a sample that overshoots', () => {
    const wav = pcmToWav([40_000, -40_000], 16_000)
    assert.equal(wav.readInt16LE(44), 32_767)
    assert.equal(wav.readInt16LE(46), -32_768)
  })
})

describe('wavToFloat32', () => {
  it('round-trips samples back into the range the stream session wants', () => {
    const { samples, sampleRate } = wavToFloat32(pcmToWav([0, 16_384, -16_384], 16_000))
    assert.equal(sampleRate, 16_000)
    assert.equal(samples.length, 3)
    assert.ok(samples.every((value) => value >= -1 && value <= 1))
    assert.ok(Math.abs(samples[1] - 0.5) < 0.001)
  })

  it('rejects something that is not a WAV file', () => {
    assert.throws(() => wavToFloat32(Buffer.from('definitely not audio')), /RIFF/)
  })
})
