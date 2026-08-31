import type { Attachment, Auction } from '~/types/auction'
import {
  archiveDocumentBlob,
  archiveDocumentText,
  type ArchivedDocumentSetItem,
  type BlobContentType,
  type DocumentIdentity,
} from '../raw-archive'
import { downloadBlob, findLatestCapture, readDocumentSet } from '../storage-download'
import { detectImageExt, type ImageExt } from './image-bytes'
import { docxBufferToText } from './docx-text'
import { buildDocumentLlmParts, buildDocumentSummaryInputs, MAP_REDUCE_DOCUMENT_THRESHOLD, type DocumentSummaryInput } from './pdf-documents'
import { extractPdfTextFromBuffer, pdfHasTrustworthyEncoding } from './pdf-text'
import { renderPdfPagesJpeg } from './pdf-render'
import type { LlmInput } from './llm'

type LlmAttachmentFormat = 'pdf' | 'docx' | 'html' | 'text' | 'image' | 'unsupported'

export interface PreparedAttachmentDocument {
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
  input: Pick<LlmInput, 'documentText' | 'documentImages' | 'pdfText' | 'pdfPageImages' | 'pdfBytes' | 'pdfDocuments'> & {
    /** Set instead of pdfText/pdfPageImages/pdfBytes/pdfDocuments when
     *  map-reduce triggered (more than MAP_REDUCE_DOCUMENT_THRESHOLD PDFs,
     *  and the caller opted in via allowMapReduce — see
     *  server/tasks/reprocess-map-reduce.ts). Undefined otherwise, including
     *  always for the batch-submission call site, which never opts in and
     *  keeps getting today's combined fields unconditionally. */
    documentSummaryInputs?: Array<DocumentSummaryInput<PreparedAttachmentDocument>>
  }
  documentSetItems: ArchivedDocumentSetItem[]
  documentSetComplete: boolean
  artifactVersionId: number | null
}

const MAX_TEXT_CHARS_PER_ATTACHMENT = 40_000
const MAX_COMBINED_DOCUMENT_TEXT_CHARS = 80_000
const DOCUMENT_KIND_PRIORITY = ['appraisal', 'brochure', 'announcement', 'photo', 'other'] as const

export function attachmentLabel(att: Attachment): string {
  return att.label || att.filename || att.fileId || att.proxyUrl
}

function extensionHaystack(att: Attachment): string {
  return `${att.filename} ${att.proxyUrl} ${att.fileId}`.toLowerCase()
}

export function formatHint(att: Attachment): LlmAttachmentFormat {
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
  const eligible = attachments.filter((attachment) => !attachment.excludeFromDocumentMining)
  const seen = new Set<string>()
  const out: Attachment[] = []
  for (const kind of DOCUMENT_KIND_PRIORITY) {
    for (const attachment of eligible) {
      if (attachment.kind !== kind || seen.has(attachment.proxyUrl)) continue
      seen.add(attachment.proxyUrl)
      out.push(attachment)
    }
  }
  for (const attachment of eligible) {
    if (seen.has(attachment.proxyUrl)) continue
    seen.add(attachment.proxyUrl)
    out.push(attachment)
  }
  return out
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
  const sections: string[] = []
  let used = 0
  const append = (raw: string): boolean => {
    if (!raw) return true
    const separatorLength = sections.length > 0 ? 2 : 0
    const remaining = MAX_COMBINED_DOCUMENT_TEXT_CHARS - used - separatorLength
    if (remaining <= 0) return false
    const text = raw.slice(0, remaining)
    if (!text) return false
    sections.push(text)
    used += separatorLength + text.length
    return raw.length <= remaining
  }
  for (const text of extraText) {
    if (!append(text)) return sections.length > 0 ? sections.join('\n\n') : null
  }
  for (const doc of documents) {
    const notice = unsupportedNotice(doc)
    if (notice) {
      if (!append(notice)) break
      continue
    }
    if (!doc.text?.trim()) continue
    if (!append(`=== ${doc.label} (${doc.format.toUpperCase()}) ===\n${doc.text.slice(0, MAX_TEXT_CHARS_PER_ATTACHMENT)}`)) break
  }
  return sections.length > 0 ? sections.join('\n\n') : null
}

async function buildPreparedInput(
  documents: readonly PreparedAttachmentDocument[],
  opts: { nativeDocuments: boolean; extraText?: string[]; allowMapReduce?: boolean } = { nativeDocuments: false },
): Promise<PreparedLlmDocuments['input']> {
  const pdfs = documents.filter((doc) => doc.format === 'pdf')
  const pdfSources = pdfs.map((doc) => ({
    source: doc,
    label: doc.label,
    text: opts.nativeDocuments ? null : doc.text,
    data: opts.nativeDocuments ? doc.bytes.toString('base64') : undefined,
  }))
  const renderOpts = {
    native: opts.nativeDocuments,
    renderPages: opts.nativeDocuments
      ? undefined
      : async (doc: PreparedAttachmentDocument, maxPages: number) =>
          (await renderPdfPagesJpeg(doc.bytes, { maxPages })).map((buf) => buf.toString('base64')),
  }
  const documentImages = documents
    .filter((doc) => doc.format === 'image' && doc.attachment.kind !== 'photo')
    .map((doc) => ({ label: doc.label, mimeType: doc.contentType, data: doc.bytes.toString('base64') }))
  const textDocuments = opts.nativeDocuments ? documents : documents.filter((doc) => doc.format !== 'pdf')
  const documentText = combineDocumentText(textDocuments, opts.extraText)

  // Skip building the combined pdfText/pdfPageImages/pdfBytes blob entirely
  // when map-reduce triggers — that blob is exactly what gets silently
  // truncated for large document sets (see MAP_REDUCE_DOCUMENT_THRESHOLD),
  // so building it here would just be wasted fetch/render work.
  if (opts.allowMapReduce && pdfs.length > MAP_REDUCE_DOCUMENT_THRESHOLD) {
    const documentSummaryInputs = await buildDocumentSummaryInputs(pdfSources, renderOpts)
    return {
      pdfText: null,
      pdfPageImages: null,
      pdfBytes: null,
      documentSummaryInputs,
      documentText,
      documentImages: documentImages.length > 0 ? documentImages : undefined,
    }
  }

  const pdfParts = await buildDocumentLlmParts(pdfSources, renderOpts)
  return {
    ...pdfParts,
    documentText,
    documentImages: documentImages.length > 0 ? documentImages : undefined,
  }
}

export async function prepareDocument(
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
  let text = format === 'pdf'
    ? opts.nativeDocuments ? null : await extractPdfTextFromBuffer(bytes)
    : textForPrepared(format, bytes)
  // A PDF whose fonts use a CJK CID encoding (seen from scanner OCR software
  // that mismapped Cyrillic onto a Japanese font) still yields plenty of
  // characters from pdftotext, just not real text — treat it the same as no
  // text at all so the caller falls back to rendering page images instead of
  // feeding the LLM homoglyph noise.
  if (format === 'pdf' && text && !(await pdfHasTrustworthyEncoding(bytes))) {
    text = null
  }
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

function attachmentFromDocumentSetItem(
  item: ArchivedDocumentSetItem,
  sourceAttachments: readonly Attachment[] = [],
): Attachment {
  const source = sourceAttachments.find((attachment) => attachment.proxyUrl === item.sourceUrl)
  return {
    kind: source?.kind ?? 'other',
    label: source?.label ?? item.label ?? item.filename ?? item.fileId ?? item.sourceUrl,
    filename: source?.filename ?? item.filename ?? '',
    sizeBytes: null,
    fileId: source?.fileId ?? item.fileId ?? '',
    proxyUrl: item.sourceUrl,
  }
}

async function prepareArchivedDocumentSetItems(
  items: readonly ArchivedDocumentSetItem[],
  artifactVersionId: number | null,
  opts: {
    nativeDocuments: boolean
    extraText?: string[]
    sourceAttachments?: readonly Attachment[]
    allowMapReduce?: boolean
  } = { nativeDocuments: false },
): Promise<PreparedLlmDocuments> {
  const prepared = (
    await Promise.all(items.map(async (item) => {
      const bytes = await downloadBlob(item.contentHash)
      if (!bytes) return null
      return prepareDocument(attachmentFromDocumentSetItem(item, opts.sourceAttachments), item.ordinal, bytes, {
        nativeDocuments: opts.nativeDocuments,
        contentHash: item.contentHash,
      })
    }))
  ).filter((doc): doc is PreparedAttachmentDocument => doc != null)

  return {
    input: await buildPreparedInput(prepared, opts),
    documentSetItems: [...items],
    documentSetComplete: prepared.length === items.length,
    artifactVersionId,
  }
}

export async function prepareArchivedLlmDocuments(
  auction: Auction,
  opts: {
    nativeDocuments: boolean
    artifactVersionId: number | null
    /** Opt-in only — see buildPreparedInput. Defaults to false/undefined so
     *  the batch-submission call site (which never sets this) keeps getting
     *  today's combined pdfText/pdfPageImages/pdfBytes behavior
     *  unconditionally, regardless of document count. */
    allowMapReduce?: boolean
  },
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

  const documentSet = opts.artifactVersionId == null
    ? null
    : await readDocumentSet(auction.platform, auction.externalId, { id: opts.artifactVersionId })
  const prepared = await prepareArchivedDocumentSetItems(documentSet?.items ?? [], documentSet?.artifactVersionId ?? null, {
    ...opts,
    extraText,
    sourceAttachments: auction.attachments,
  })
  if (opts.artifactVersionId == null) return prepared
  return documentSet == null ? { ...prepared, documentSetComplete: false } : prepared
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

// Live crawl-time document preparation (fetches attachments over HTTP, as
// opposed to everything above which reads already-archived blobs) lives in
// its own module — this file was pushing the 500-line module-size ceiling.
// Re-exported here so callers keep importing from this file unchanged.
export { prepareLiveLlmDocuments, type ArchivedLiveDocuments } from './llm-documents-live'
