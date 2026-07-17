// Fetches an attachment DOCX and extracts its text. A .docx is a ZIP archive
// containing `word/document.xml` — this reads just that one entry via a
// minimal ZIP central-directory walk plus zlib's raw inflate, avoiding a
// dependency on a full archive/DOCX library for a single-file read.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const CACHE_DIR = join(process.cwd(), '.cache_zvg', 'docxtext')

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIR_SIGNATURE = 0x02014b50
const ZIP_MAX_COMMENT_BYTES = 0xffff
const MAX_DOCX_BYTES = 20 * 1024 * 1024

/** Read one named entry out of a ZIP buffer, or null if absent/unreadable. */
function readZipEntry(buf: Buffer, entryName: string): Buffer | null {
  try {
    if (buf.length < 22) return null

    let eocd = -1
    const eocdSearchStart = Math.max(0, buf.length - 22 - ZIP_MAX_COMMENT_BYTES)
    for (let i = buf.length - 22; i >= eocdSearchStart; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return null

    const entryCount = buf.readUInt16LE(eocd + 10)
    let offset = buf.readUInt32LE(eocd + 16)

    for (let i = 0; i < entryCount; i++) {
      if (offset < 0 || offset + 46 > buf.length) return null
      if (buf.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) break
      const compressionMethod = buf.readUInt16LE(offset + 10)
      const compressedSize = buf.readUInt32LE(offset + 20)
      const nameLength = buf.readUInt16LE(offset + 28)
      const extraLength = buf.readUInt16LE(offset + 30)
      const commentLength = buf.readUInt16LE(offset + 32)
      const localHeaderOffset = buf.readUInt32LE(offset + 42)
      const nameStart = offset + 46
      const nameEnd = nameStart + nameLength
      if (nameEnd > buf.length) return null
      const name = buf.toString('utf8', nameStart, nameEnd)

      if (name === entryName) {
        if (localHeaderOffset + 30 > buf.length) return null
        const localNameLength = buf.readUInt16LE(localHeaderOffset + 26)
        const localExtraLength = buf.readUInt16LE(localHeaderOffset + 28)
        const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
        const dataEnd = dataStart + compressedSize
        if (dataStart < 0 || dataEnd > buf.length) return null
        const data = buf.subarray(dataStart, dataEnd)
        if (compressionMethod === 0) return data
        if (compressionMethod === 8) return inflateRawSync(data)
        return null
      }
      offset += 46 + nameLength + extraLength + commentLength
    }
    return null
  } catch {
    return null
  }
}

/** Strip WordprocessingML markup to plain text, keeping paragraph/tab breaks. */
function documentXmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Fetch the DOCX at `url` and return its text, or null on any failure. */
export async function docxToText(url: string): Promise<string | null> {
  const key = createHash('sha1').update(url).digest('hex')
  const cachePath = join(CACHE_DIR, `${key}.txt`)
  try {
    return await readFile(cachePath, 'utf8')
  } catch {
    // miss — fetch + extract below
  }

  let buf: Buffer
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'zvg-immo/1.0', Accept: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    const contentLength = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(contentLength) && contentLength > MAX_DOCX_BYTES) return null
    buf = Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
  if (buf.length > MAX_DOCX_BYTES) return null
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) return null

  const xml = readZipEntry(buf, 'word/document.xml')
  if (!xml) return null
  const text = documentXmlToText(xml.toString('utf8'))
  if (!text) return null

  try {
    await mkdir(CACHE_DIR, { recursive: true })
    const tmp = `${cachePath}.${randomUUID()}.tmp`
    await writeFile(tmp, text)
    await rename(tmp, cachePath)
  } catch {
    // Cache failures must not turn a successful extraction into a failed one.
  }
  return text
}
