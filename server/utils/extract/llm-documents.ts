import type { Attachment, Auction } from '~/types/auction'
import { UA, ZVG_BASE } from '~/server/crawlers/zvg-portal/constants'
import {
  archiveDocumentBlob,
  archiveDocumentText,
  type ArchivedDocumentSetItem,
  type BlobContentType,
  type DocumentIdentity,
} from '../raw-archive'
import { downloadBlob, findLatestCapture, readDocumentSetItems } from '../storage-download'
import { detectImageExt, type ImageExt } from './image-bytes'
import { docxBufferToText } from './docx-text'
import { buildDocumentLlmParts } from './pdf-documents'
import { extractPdfTextFromBuffer } from './pdf-text'
import { renderPdfPagesJpeg } from './pdf-render'
import type { LlmInput } from './llm'

type LlmAttachmentFormat = 'pdf' | 'docx' | 'html' | 'text' | 'image' | 'unsupported'

interface PreparedAttachmentDocument {
  attachment: Attachment
  ordinal: number
  label: string
  format: LlmAttachmentFormat
  contentType: BlobContentType
  bytes: Buffer
  contentHash: string | null
  text: string | null
}

export interface PreparedLlmDocuments {
  input: Pick<LlmInput, 'documentText' | 'documentImages' | 'pdfText' | 'pdfPageImages' | 'pdfBytes' | 'pdfDocuments'>
  documentSetItems: ArchivedDocumentSetItem[]
  documentSetComplete: boolean
}

export interface ArchivedLiveDocuments {
  documentSetItems: ArchivedDocumentSetItem[]
  documentSetComplete: boolean
}

const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024
const MAX_TEXT_CHARS_PER_ATTACHMENT = 40_000
const DOCUMENT_KIND_PRIORITY = ['appraisal', 'brochure', 'announcement', 'photo', 'other'] as const

function attachmentLabel(att: Attachment): string {
  return att.label || att.filename || att.fileId || att.proxyUrl
}

function extensionHaystack(att: Attachment): string {
  return `${att.filename} ${att.proxyUrl} ${att.fileId}`.toLowerCase()
}

function formatHint(att: Attachment): LlmAttachmentFormat {
  const haystack = extensionHaystack(att)
  if (/\.(?:pdf)(?:[\s?#]|$)/.test(haystack) || /(?:^|[/.?=&_-])pdf(?:[\s?#&._=-]|$)/.test(haystack)) return 'pdf'
  if (/\.(?:docx)(?:[\s?#]|$)/.test(haystack) || /(?:^|[/.?=&_-])docx(?:[\s?#&._=-]|$)/.test(haystack)) return 'docx'
  if (/\.(?:html?|xhtml)(?:[\s?#]|$)/.test(haystack)) return 'html'
  if (/\.(?:txt|text|csv|rtf)(?:[\s?#]|$)/.test(haystack)) return 'text'
  if (/\.(?:jpe?g|png|webp)(?:[\s?#]|$)/.test(haystack)) return 'image'
  if (att.kind === 'photo') return 'image'
  return 'unsupported'
}

export function pickAllLlmDocumentAttachments(attachments: readonly Attachment[]): Attachment[] {
  const seen = new Set<string>()
  const out: Attachment[] = []
  for (const kind of DOCUMENT_KIND_PRIORITY) {
    for (const attachment of attachments) {
      if (attachment.kind !== kind || seen.has(attachment.proxyUrl)) continue
      seen.add(attachment.proxyUrl)
      out.push(attachment)
    }
  }
  for (const attachment of attachments) {
    if (seen.has(attachment.proxyUrl)) continue
    seen.add(attachment.proxyUrl)
    out.push(attachment)
  }
  return out
}

function acceptForHint(format: LlmAttachmentFormat): string {
  switch (format) {
    case 'pdf':
      return 'application/pdf,*/*'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*'
    case 'html':
      return 'text/html,application/xhtml+xml,*/*'
    case 'text':
      return 'text/plain,text/rtf,*/*'
    case 'image':
      return 'image/jpeg,image/png,image/webp,*/*'
    default:
      return '*/*'
  }
}

function resolveAttachmentSource(proxyUrl: string, accept: string): { url: string; headers: Record<string, string> } {
  if (proxyUrl.startsWith('/api/zvg-proxy')) {
    const q = new URLSearchParams(proxyUrl.split('?')[1] ?? '')
    const url = `${ZVG_BASE}/index.php?button=showAnhang&land_abk=${q.get('land_abk')}&file_id=${q.get('file_id')}&zvg_id=${q.get('zvg_id')}`
    return { url, headers: { 'User-Agent': UA, Accept: accept, Referer: `${ZVG_BASE}/index.php?button=Suchen` } }
  }
  return { url: proxyUrl, headers: { 'User-Agent': UA, Accept: accept } }
}

async function fetchAttachmentBytes(att: Attachment): Promise<Buffer | null> {
  const { url, headers } = resolveAttachmentSource(att.proxyUrl, acceptForHint(formatHint(att)))
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return null
    const contentLength = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_BYTES) {
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
      if (total > MAX_ATTACHMENT_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, total)
  } catch {
    return null
  }
}

function looksTextual(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096))
  if (sample.includes(0)) return false
  if (sample.length === 0) return false
  let printable = 0
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127)) printable++
  }
  return printable / sample.length > 0.85
}

function imageMime(ext: ImageExt): BlobContentType {
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  return 'image/jpeg'
}

function inferFormat(att: Attachment, bytes: Buffer): { format: LlmAttachmentFormat; contentType: BlobContentType } {
  const hint = formatHint(att)
  if (bytes.subarray(0, 5).toString('ascii').startsWith('%PDF-')) return { format: 'pdf', contentType: 'application/pdf' }
  const imageExt = detectImageExt(bytes)
  if (imageExt) return { format: 'image', contentType: imageMime(imageExt) }
  if (hint === 'docx' && bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
    return { format: 'docx', contentType: 'application/vnd.docx' }
  }
  if (looksTextual(bytes)) {
    const text = bytes.toString('utf8', 0, Math.min(bytes.length, 4096)).toLowerCase()
    if (
      hint === 'html' ||
      /<!doctype\s+html|<html\b|<body\b|<table\b|<div\b|<p\b/i.test(text)
    ) {
      return { format: 'html', contentType: 'text/html' }
    }
    return { format: 'text', contentType: 'text/plain' }
  }
  return { format: 'unsupported', contentType: 'application/octet-stream' }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => {
      const code = Number.parseInt(n, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
}

export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, '\n')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '\n')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '\n')
      .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(?:p|div|section|article|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function rtfToText(rtf: string): string {
  return rtf
    .replace(/\\'[0-9a-f]{2}/gi, ' ')
    .replace(/\\par[d]?/gi, '\n')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function textForPrepared(format: LlmAttachmentFormat, bytes: Buffer): string | null {
  if (format === 'pdf') return null
  if (format === 'docx') return docxBufferToText(bytes)
  if (format === 'html') return htmlToText(bytes.toString('utf8'))
  if (format === 'text') {
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '')
    return text.trim().startsWith('{\\rtf') ? rtfToText(text) : text.trim()
  }
  return null
}

function unsupportedNotice(doc: PreparedAttachmentDocument): string | null {
  if (doc.format !== 'unsupported') return null
  return `=== ${doc.label} (nicht dekodierbarer Anhang) ===\n` +
    `Der archivierte Anhang konnte nicht als PDF, DOCX, HTML/Text oder Bild gelesen werden. Dateiname: ${doc.attachment.filename || 'unbekannt'}.`
}

function combineDocumentText(documents: readonly PreparedAttachmentDocument[], extraText: string[] = []): string | null {
  const sections = [...extraText]
  for (const doc of documents) {
    const notice = unsupportedNotice(doc)
    if (notice) {
      sections.push(notice)
      continue
    }
    if (!doc.text?.trim()) continue
    sections.push(`=== ${doc.label} (${doc.format.toUpperCase()}) ===\n${doc.text.slice(0, MAX_TEXT_CHARS_PER_ATTACHMENT)}`)
  }
  return sections.length > 0 ? sections.join('\n\n') : null
}

async function buildPreparedInput(
  documents: readonly PreparedAttachmentDocument[],
  opts: { nativeDocuments: boolean; extraText?: string[] } = { nativeDocuments: false },
): Promise<PreparedLlmDocuments['input']> {
  const pdfs = documents.filter((doc) => doc.format === 'pdf')
  const pdfParts = await buildDocumentLlmParts(
    pdfs.map((doc) => ({
      source: doc,
      label: doc.label,
      text: opts.nativeDocuments ? null : doc.text,
      data: opts.nativeDocuments ? doc.bytes.toString('base64') : undefined,
    })),
    {
      native: opts.nativeDocuments,
      renderPages: opts.nativeDocuments
        ? undefined
        : async (doc, maxPages) => (await renderPdfPagesJpeg(doc.bytes, { maxPages })).map((buf) => buf.toString('base64')),
    },
  )
  const documentImages = documents
    .filter((doc) => doc.format === 'image')
    .map((doc) => ({ label: doc.label, mimeType: doc.contentType, data: doc.bytes.toString('base64') }))
  return {
    ...pdfParts,
    documentText: combineDocumentText(documents, opts.extraText),
    documentImages: documentImages.length > 0 ? documentImages : undefined,
  }
}

async function prepareDocument(
  attachment: Attachment,
  ordinal: number,
  bytes: Buffer,
  opts: { identity?: DocumentIdentity; capturedAt?: string; nativeDocuments: boolean; contentHash?: string | null },
): Promise<PreparedAttachmentDocument> {
  const { format, contentType } = inferFormat(attachment, bytes)
  const contentHash = opts.contentHash ?? (
    opts.identity && opts.capturedAt
      ? await archiveDocumentBlob(bytes, contentType, opts.identity, attachment.proxyUrl, opts.capturedAt)
      : null
  )
  const text = format === 'pdf'
    ? opts.nativeDocuments ? null : await extractPdfTextFromBuffer(bytes)
    : textForPrepared(format, bytes)
  if (text?.trim() && opts.identity && opts.capturedAt) {
    await archiveDocumentText(text, opts.identity, attachment.proxyUrl, opts.capturedAt)
  }
  return {
    attachment,
    ordinal,
    label: attachmentLabel(attachment),
    format,
    contentType,
    bytes,
    contentHash,
    text,
  }
}

export async function prepareLiveLlmDocuments(
  attachments: readonly Attachment[],
  identity: DocumentIdentity,
  capturedAt: string,
): Promise<ArchivedLiveDocuments> {
  const candidates = pickAllLlmDocumentAttachments(attachments)
  const prepared = (
    await Promise.all(candidates.map(async (attachment, ordinal) => {
      const bytes = await fetchAttachmentBytes(attachment)
      if (!bytes) return null
      return prepareDocument(attachment, ordinal, bytes, {
        identity,
        capturedAt,
        nativeDocuments: false,
      })
    }))
  ).filter((doc): doc is PreparedAttachmentDocument => doc != null)
  const documentSetItems = prepared
    .filter((doc): doc is PreparedAttachmentDocument & { contentHash: string } => !!doc.contentHash)
    .map((doc) => ({
      ordinal: doc.ordinal,
      kind: 'document' as const,
      label: doc.attachment.label || null,
      filename: doc.attachment.filename || null,
      fileId: doc.attachment.fileId || null,
      sourceUrl: doc.attachment.proxyUrl,
      contentHash: doc.contentHash,
      contentType: doc.contentType,
    }))
  return {
    documentSetItems,
    documentSetComplete: documentSetItems.length === candidates.length,
  }
}

function attachmentFromDocumentSetItem(item: ArchivedDocumentSetItem): Attachment {
  return {
    kind: 'other',
    label: item.label ?? item.filename ?? item.fileId ?? item.sourceUrl,
    filename: item.filename ?? '',
    sizeBytes: null,
    fileId: item.fileId ?? '',
    proxyUrl: item.sourceUrl,
  }
}

async function prepareArchivedDocumentSetItems(
  items: readonly ArchivedDocumentSetItem[],
  opts: { nativeDocuments: boolean; extraText?: string[] } = { nativeDocuments: false },
): Promise<PreparedLlmDocuments> {
  const prepared = (
    await Promise.all(items.map(async (item) => {
      const bytes = await downloadBlob(item.contentHash)
      if (!bytes) return null
      return prepareDocument(attachmentFromDocumentSetItem(item), item.ordinal, bytes, {
        nativeDocuments: opts.nativeDocuments,
        contentHash: item.contentHash,
      })
    }))
  ).filter((doc): doc is PreparedAttachmentDocument => doc != null)

  return {
    input: await buildPreparedInput(prepared, opts),
    documentSetItems: [...items],
    documentSetComplete: prepared.length === items.length,
  }
}

export async function prepareArchivedLlmDocuments(
  auction: Auction,
  opts: { nativeDocuments: boolean; documentSetHash?: string | null; documentSetVersion?: number | null },
): Promise<PreparedLlmDocuments> {
  const extraText: string[] = []
  const detailCapture = await findLatestCapture('detail_html', auction.platform, auction.externalId)
  if (detailCapture) {
    const detailBytes = await downloadBlob(detailCapture.contentHash)
    if (detailBytes && looksTextual(detailBytes)) {
      const detailText = htmlToText(detailBytes.toString('utf8'))
      if (detailText) extraText.push(`=== Detailseite HTML ===\n${detailText.slice(0, MAX_TEXT_CHARS_PER_ATTACHMENT)}`)
    }
  }

  const documentSetItems = await readDocumentSetItems(auction.platform, auction.externalId, {
    setHash: opts.documentSetHash,
    version: opts.documentSetVersion,
  })
  return prepareArchivedDocumentSetItems(documentSetItems ?? [], { ...opts, extraText })
}

export async function readArchivedAuction(platform: string, externalId: string): Promise<Auction | null> {
  const capture = await findLatestCapture('auction', platform, externalId)
  if (!capture) return null
  const bytes = await downloadBlob(capture.contentHash)
  if (!bytes) return null
  try {
    return JSON.parse(bytes.toString('utf8')) as Auction
  } catch {
    return null
  }
}
