import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { Attachment } from '~/types/auction'
import { UA, ZVG_BASE } from '~/server/crawlers/zvg-portal/constants'
import { downloadNativeImages } from './native-images'
import { extractPdfPhotos } from './pdf-images'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIR_SIGNATURE = 0x02014b50
const ZIP_MAX_COMMENT_BYTES = 0xffff
const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024
const MAX_INFLATED_BYTES = 30 * 1024 * 1024
const MIN_IMAGE_BYTES = 512

const DOCUMENT_KIND_PRIORITY = ['appraisal', 'brochure', 'announcement', 'photo', 'other'] as const
const DOCUMENT_FORMAT_PRIORITY = ['pdf', 'docx', 'html'] as const

type DocumentImageFormat = 'pdf' | 'docx' | 'html'

interface ZipEntry {
  name: string
  bytes: Buffer
}

export interface ExtractDocumentPhotosOptions {
  destDir: string
  maxPhotos?: number
}

function formatOf(att: Attachment): DocumentImageFormat | null {
  const haystack = `${att.filename} ${att.proxyUrl} ${att.fileId}`.toLowerCase()
  if (/\.(?:pdf)(?:[\s?#]|$)/.test(haystack) || /(?:^|[/.?=&_-])pdf(?:[\s?#&._=-]|$)/.test(haystack)) return 'pdf'
  if (/\.(?:docx)(?:[\s?#]|$)/.test(haystack) || /(?:^|[/.?=&_-])docx(?:[\s?#&._=-]|$)/.test(haystack)) return 'docx'
  if (/\.(?:html?|xhtml)(?:[\s?#]|$)/.test(haystack)) return 'html'
  return null
}

export function pickDocumentImageCandidates(attachments: readonly Attachment[]): Attachment[] {
  const seen = new Set<string>()
  const out: Attachment[] = []
  for (const format of DOCUMENT_FORMAT_PRIORITY) {
    for (const kind of DOCUMENT_KIND_PRIORITY) {
      for (const att of attachments) {
        if (att.kind !== kind || formatOf(att) !== format || seen.has(att.proxyUrl)) continue
        seen.add(att.proxyUrl)
        out.push(att)
      }
    }
  }
  return out
}

function resolveDocumentSource(proxyUrl: string, accept: string): { url: string; headers: Record<string, string> } {
  if (proxyUrl.startsWith('/api/zvg-proxy')) {
    const q = new URLSearchParams(proxyUrl.split('?')[1] ?? '')
    const url = `${ZVG_BASE}/index.php?button=showAnhang&land_abk=${q.get('land_abk')}&file_id=${q.get('file_id')}&zvg_id=${q.get('zvg_id')}`
    return { url, headers: { 'User-Agent': UA, Accept: accept, Referer: `${ZVG_BASE}/index.php?button=Suchen` } }
  }
  return { url: proxyUrl, headers: { 'User-Agent': UA, Accept: accept } }
}

async function fetchDocumentBytes(proxyUrl: string, accept: string): Promise<Buffer | null> {
  const { url, headers } = resolveDocumentSource(proxyUrl, accept)
  let buf: Buffer
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) {
      if (res.status === 408 || res.status === 429 || res.status >= 500) {
        throw new Error(`document fetch failed with HTTP ${res.status}`)
      }
      return null
    }
    const contentLength = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(contentLength) && contentLength > MAX_DOCUMENT_BYTES) return null
    buf = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    if (err instanceof Error && /document fetch failed/.test(err.message)) throw err
    throw new Error(`document fetch failed: ${(err as Error).message}`)
  }
  return buf.length > MAX_DOCUMENT_BYTES ? null : buf
}

function readZipEntries(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = []
  if (buf.length < 22) return entries

  let eocd = -1
  const eocdSearchStart = Math.max(0, buf.length - 22 - ZIP_MAX_COMMENT_BYTES)
  for (let i = buf.length - 22; i >= eocdSearchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return entries

  const entryCount = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < entryCount; i++) {
    if (offset < 0 || offset + 46 > buf.length) return entries
    if (buf.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) break
    const compressionMethod = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localHeaderOffset = buf.readUInt32LE(offset + 42)
    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > buf.length) return entries
    const name = buf.toString('utf8', nameStart, nameEnd)
    offset += 46 + nameLength + extraLength + commentLength

    if (localHeaderOffset + 30 > buf.length) continue
    const localNameLength = buf.readUInt16LE(localHeaderOffset + 26)
    const localExtraLength = buf.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataStart < 0 || dataEnd > buf.length) continue
    const data = buf.subarray(dataStart, dataEnd)
    try {
      if (compressionMethod === 0) entries.push({ name, bytes: Buffer.from(data) })
      if (compressionMethod === 8) entries.push({ name, bytes: inflateRawSync(data, { maxOutputLength: MAX_INFLATED_BYTES }) })
    } catch {
      // One corrupt member should not discard the rest of the document.
    }
  }
  return entries
}

function detectImageExt(buf: Buffer): 'jpg' | 'png' | 'webp' | null {
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

function imageSize(buf: Buffer): { width: number; height: number } | null {
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
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { height: buf.readUInt16BE(offset + 3), width: buf.readUInt16BE(offset + 5) }
      }
      offset += length
    }
  }
  return null
}

function isLikelyPhoto(buf: Buffer): boolean {
  if (buf.length < MIN_IMAGE_BYTES || !detectImageExt(buf)) return false
  const size = imageSize(buf)
  if (!size) return true
  if (size.width < 300 || size.height < 200) return false
  const aspect = Math.max(size.width / size.height, size.height / size.width)
  if (aspect > 6) return false
  const ratio = size.width / size.height
  const longestSide = Math.max(size.width, size.height)
  return !(longestSide < 1000 && ratio >= 0.85 && ratio <= 1.15)
}

async function writeImageBytes(entries: readonly Buffer[], opts: ExtractDocumentPhotosOptions): Promise<string[]> {
  if (entries.length === 0) return []
  await mkdir(opts.destDir, { recursive: true })
  const seen = new Set<string>()
  const written: string[] = []
  for (const bytes of entries) {
    if (written.length >= (opts.maxPhotos ?? 12)) break
    if (!isLikelyPhoto(bytes)) continue
    const ext = detectImageExt(bytes)
    if (!ext) continue
    const hash = createHash('md5').update(bytes).digest('hex')
    if (seen.has(hash)) continue
    seen.add(hash)
    const name = `${hash.slice(0, 16)}.${ext}`
    await writeFile(join(opts.destDir, name), bytes)
    written.push(name)
  }
  return written
}

async function extractDocxPhotos(proxyUrl: string, opts: ExtractDocumentPhotosOptions): Promise<string[]> {
  const buf = await fetchDocumentBytes(
    proxyUrl,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*',
  )
  if (!buf) return []
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) return []
  const media = readZipEntries(buf)
    .filter((entry) => /^word\/media\/.+\.(?:jpe?g|png|webp)$/i.test(entry.name))
    .map((entry) => entry.bytes)
  return writeImageBytes(media, opts)
}

function absoluteImageUrl(raw: string, baseUrl: string): string | null {
  if (/^https?:\/\//i.test(raw)) return raw
  if (!/^https?:\/\//i.test(baseUrl)) return null
  try {
    return new URL(raw, baseUrl).toString()
  } catch {
    return null
  }
}

export function extractHtmlImageUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = []
  const add = (raw: string | undefined) => {
    if (!raw) return
    const clean = raw.trim().replace(/^['"]|['"]$/g, '')
    if (!clean || /^data:/i.test(clean)) return
    const url = absoluteImageUrl(clean, baseUrl)
    if (url && !urls.includes(url)) urls.push(url)
  }
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0]
    const srcset = tag.match(/\bsrcset\s*=\s*(["'])(.*?)\1/i)?.[2]
    if (srcset) {
      for (const candidate of srcset.split(',')) add(candidate.trim().split(/\s+/)[0])
    }
    add(tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2])
  }
  return urls
}

async function extractHtmlPhotos(proxyUrl: string, opts: ExtractDocumentPhotosOptions): Promise<string[]> {
  const buf = await fetchDocumentBytes(proxyUrl, 'text/html,application/xhtml+xml,*/*')
  if (!buf) return []
  const urls = extractHtmlImageUrls(buf.toString('utf8'), proxyUrl)
  const downloaded = await downloadNativeImages(urls, { destDir: opts.destDir, maxImages: opts.maxPhotos })
  const photos: string[] = []
  for (const name of downloaded) {
    try {
      if (isLikelyPhoto(await readFile(join(opts.destDir, name)))) photos.push(name)
    } catch {
      // Ignore a raced/missing local file; the photo pipeline can continue
      // with other successfully downloaded images.
    }
  }
  return photos
}

export async function extractDocumentPhotos(
  attachments: readonly Attachment[],
  opts: ExtractDocumentPhotosOptions,
): Promise<string[]> {
  const candidates = pickDocumentImageCandidates(attachments)
  const photos: string[] = []
  let failed = false

  for (const candidate of candidates) {
    if (photos.length >= (opts.maxPhotos ?? 12)) break
    const maxPhotos = (opts.maxPhotos ?? 12) - photos.length
    const format = formatOf(candidate)
    try {
      const found = format === 'pdf'
        ? await extractPdfPhotos(candidate.proxyUrl, { destDir: opts.destDir, maxPhotos })
        : format === 'docx'
          ? await extractDocxPhotos(candidate.proxyUrl, { destDir: opts.destDir, maxPhotos })
          : format === 'html'
            ? await extractHtmlPhotos(candidate.proxyUrl, { destDir: opts.destDir, maxPhotos })
            : []
      for (const name of found) if (!photos.includes(name)) photos.push(name)
    } catch {
      failed = true
    }
  }

  if (photos.length === 0 && failed) {
    throw new Error(`document photo extraction failed for all ${candidates.length} candidate document(s)`)
  }
  return photos
}
