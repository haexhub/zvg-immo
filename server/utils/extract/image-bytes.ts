import { createHash } from 'node:crypto'

export type ImageExt = 'jpg' | 'png' | 'webp'

/** JPEG/PNG/WebP magic bytes. Guards against upstreams that return HTML/JSON
 *  error pages with a 200 status. */
export function detectImageExt(buf: Buffer): ImageExt | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png'
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'webp'
  }
  return null
}

export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && detectImageExt(buf) === 'png') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (detectImageExt(buf) === 'jpg') {
    let offset = 2
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) return null
      const marker = buf[offset + 1]
      offset += 2
      if (marker == null || marker === 0xd9 || marker === 0xda) break
      if (offset + 2 > buf.length) break
      const length = buf.readUInt16BE(offset)
      if (length < 2 || offset + length > buf.length) break
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { height: buf.readUInt16BE(offset + 3), width: buf.readUInt16BE(offset + 5) }
      }
      offset += length
    }
  }
  return null
}

export function imageContentHash(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

export function imageContentFilename(buf: Buffer, ext: ImageExt): string {
  return `${imageContentHash(buf)}.${ext}`
}
