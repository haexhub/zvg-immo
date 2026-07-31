import { lookup } from 'node:dns/promises'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ipaddr from 'ipaddr.js'
import { Agent } from 'undici'
import { fromBufferPromise, validateFileName, type Entry, type ZipFile } from 'yauzl'
import type { Attachment } from '~/types/auction'
import { UA, ZVG_BASE } from '~/server/crawlers/zvg-portal/constants'
import { detectImageExt, imageContentFilename, imageContentHash, imageSize } from './image-bytes'
import { downloadNativeImages } from './native-images'
import { extractPdfPhotos } from './pdf-images'

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

interface PinnedHost {
  address: string
  family: 4 | 6
}

export interface ExtractDocumentPhotosOptions {
  destDir: string
  maxPhotos?: number
}

function maxPhotosLimit(maxPhotos: number | undefined): number {
  return maxPhotos ?? Number.POSITIVE_INFINITY
}

function childPhotoOptions(destDir: string, maxPhotos: number | undefined): ExtractDocumentPhotosOptions {
  return maxPhotos == null ? { destDir } : { destDir, maxPhotos }
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
  if (proxyUrl.startsWith(`${ZVG_BASE}/`)) {
    return {
      url: proxyUrl,
      headers: { 'User-Agent': UA, Accept: accept, Referer: `${ZVG_BASE}/index.php?button=Suchen` },
    }
  }
  return { url: proxyUrl, headers: { 'User-Agent': UA, Accept: accept } }
}

async function fetchDocumentBytes(proxyUrl: string, accept: string): Promise<Buffer | null> {
  const { url, headers } = resolveDocumentSource(proxyUrl, accept)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    if (!res.ok) {
      if (res.status === 408 || res.status === 429 || res.status >= 500) {
        throw new Error(`document fetch failed with HTTP ${res.status}`)
      }
      await res.body?.cancel().catch(() => undefined)
      return null
    }
    const contentLength = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(contentLength) && contentLength > MAX_DOCUMENT_BYTES) {
      await res.body?.cancel().catch(() => undefined)
      return null
    }
    if (!res.body) return null
    const reader = res.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_DOCUMENT_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, total)
  } catch (err) {
    if (err instanceof Error && /document fetch failed/.test(err.message)) throw err
    throw new Error(`document fetch failed: ${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}

async function readZipEntryBytes(zip: ZipFile, entry: Entry): Promise<Buffer | null> {
  if (!entry.canDecodeFileData() || entry.isEncrypted() || entry.uncompressedSize > MAX_INFLATED_BYTES) return null
  return new Promise((resolve) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        resolve(null)
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      let resolved = false
      const done = (bytes: Buffer | null) => {
        if (resolved) return
        resolved = true
        resolve(bytes)
      }
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_INFLATED_BYTES) {
          stream.destroy()
          done(null)
          return
        }
        chunks.push(chunk)
      })
      stream.on('end', () => done(Buffer.concat(chunks, total)))
      stream.on('error', () => done(null))
    })
  })
}

async function readZipEntries(buf: Buffer): Promise<ZipEntry[]> {
  let zip: ZipFile
  try {
    zip = await fromBufferPromise(buf, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true })
  } catch {
    return []
  }
  const entries: ZipEntry[] = []
  try {
    for await (const entry of zip.eachEntry()) {
      if (entries.length >= 200) break
      if (entry.fileName.endsWith('/') || validateFileName(entry.fileName) !== null) continue
      const bytes = await readZipEntryBytes(zip, entry)
      if (bytes) entries.push({ name: entry.fileName, bytes })
    }
  } catch {
    entries.length = 0
  } finally {
    zip.close()
  }
  return entries
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
  const maxPhotos = maxPhotosLimit(opts.maxPhotos)
  for (const bytes of entries) {
    if (written.length >= maxPhotos) break
    if (!isLikelyPhoto(bytes)) continue
    const ext = detectImageExt(bytes)
    if (!ext) continue
    const hash = imageContentHash(bytes)
    if (seen.has(hash)) continue
    seen.add(hash)
    const name = imageContentFilename(bytes, ext)
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
  const media = (await readZipEntries(buf))
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

function isPublicIp(address: string): boolean {
  if (!ipaddr.isValid(address)) return false
  const parsed = ipaddr.parse(address)
  return parsed.range() === 'unicast'
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

async function resolvePublicHost(hostname: string): Promise<PinnedHost | null> {
  const normalized = normalizeHostname(hostname)
  if (ipaddr.isValid(normalized)) {
    const parsed = ipaddr.parse(normalized)
    const family = parsed.kind() === 'ipv4' ? 4 : 6
    return isPublicIp(normalized) ? { address: normalized, family } : null
  }
  const records = await lookup(normalized, { all: true, verbatim: true }).catch(() => [])
  if (records.length === 0 || records.some((record) => !isPublicIp(record.address))) return null
  const first = records[0]!
  if (first.family !== 4 && first.family !== 6) return null
  return { address: first.address, family: first.family }
}

async function pinPublicImageUrls(urls: readonly string[]): Promise<{ urls: string[]; dispatcher: Agent | null }> {
  const pinned = new Map<string, PinnedHost>()
  const out: string[] = []
  for (const raw of urls) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    const key = normalizeHostname(url.hostname).toLowerCase()
    const resolved = pinned.get(key) ?? await resolvePublicHost(url.hostname)
    if (!resolved) continue
    pinned.set(key, resolved)
    out.push(url.toString())
  }
  if (out.length === 0) return { urls: [], dispatcher: null }
  const dispatcher = new Agent({
    connect: {
      lookup(hostname, _opts, callback) {
        const resolved = pinned.get(normalizeHostname(hostname).toLowerCase())
        if (!resolved) {
          callback(new Error(`unpinned host: ${hostname}`), '', 0)
          return
        }
        callback(null, resolved.address, resolved.family)
      },
    },
  })
  return { urls: out, dispatcher }
}

async function extractHtmlPhotos(proxyUrl: string, opts: ExtractDocumentPhotosOptions): Promise<string[]> {
  const buf = await fetchDocumentBytes(proxyUrl, 'text/html,application/xhtml+xml,*/*')
  if (!buf) return []
  const urls = extractHtmlImageUrls(buf.toString('utf8'), proxyUrl)
  const pinned = await pinPublicImageUrls(urls)
  if (!pinned.urls.length || !pinned.dispatcher) return []
  let downloaded: string[]
  try {
    downloaded = await downloadNativeImages(pinned.urls, {
      destDir: opts.destDir,
      maxImages: maxPhotosLimit(opts.maxPhotos),
      dispatcher: pinned.dispatcher,
      redirect: 'manual',
    })
  } finally {
    await pinned.dispatcher.close()
  }
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
  let lastError: string | null = null
  const maxPhotos = maxPhotosLimit(opts.maxPhotos)

  for (const candidate of candidates) {
    if (photos.length >= maxPhotos) break
    const remainingPhotos = Number.isFinite(maxPhotos) ? maxPhotos - photos.length : undefined
    const format = formatOf(candidate)
    try {
      const found = format === 'pdf'
        ? await extractPdfPhotos(candidate.proxyUrl, childPhotoOptions(opts.destDir, remainingPhotos))
        : format === 'docx'
          ? await extractDocxPhotos(candidate.proxyUrl, childPhotoOptions(opts.destDir, remainingPhotos))
          : format === 'html'
            ? await extractHtmlPhotos(candidate.proxyUrl, childPhotoOptions(opts.destDir, remainingPhotos))
            : []
      for (const name of found) if (!photos.includes(name)) photos.push(name)
    } catch (err) {
      failed = true
      lastError = (err as Error).message
    }
  }

  if (photos.length === 0 && failed) {
    throw new Error(`document photo extraction failed for all ${candidates.length} candidate document(s)${lastError ? `: ${lastError}` : ''}`)
  }
  return photos
}
