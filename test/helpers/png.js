// A generated test image keeps the vision test honest without committing a
// binary or depending on the corpus, which is not in this repository.
import { deflateSync } from 'node:zlib'

const table = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

const crc32 = (buffer) => {
  let value = 0xffffffff
  for (const byte of buffer) value = table[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, checksum])
}

export const squareOnWhite = (size, rgb) => {
  const row = 1 + size * 3
  const raw = Buffer.alloc(size * row)
  const inset = Math.floor(size / 8)

  for (let y = 0; y < size; y += 1) {
    const start = y * row
    for (let x = 0; x < size; x += 1) {
      const inside = x >= inset && x < size - inset && y >= inset && y < size - inset
      raw.set(inside ? rgb : [255, 255, 255], start + 1 + x * 3)
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2 // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
