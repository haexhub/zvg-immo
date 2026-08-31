export interface DocumentLlmSource<T> {
  source: T
  label: string
  text?: string | null
  data?: string
}

export interface DocumentLlmParts {
  pdfText: string | null
  pdfPageImages: string[] | null
  pdfBytes: string | null
  pdfDocuments?: Array<{ label: string; data: string }>
}

const SCANNED_PDF_TEXT_THRESHOLD = 200
const MAX_SCANNED_DOCUMENTS = 3
const MAX_PAGES_PER_DOCUMENT = 8
const MAX_RENDERED_PAGES = 20
/** Must match llm.ts's provider-facing PDF text cap. */
export const MAX_MAP_REDUCE_DOCUMENT_TEXT_CHARS = 24_000

/** Map-reduce (server/tasks/reprocess-map-reduce.ts): the point past which
 *  the single combined-call path (buildDocumentLlmParts above) already
 *  starts silently losing content — MAX_SCANNED_DOCUMENTS scanned docs get
 *  page images at all, everything beyond that is dropped, and the combined
 *  text budget (MAX_COMBINED_DOCUMENT_TEXT_CHARS in llm-documents.ts) is
 *  shared across every document instead of per-document. Same value as
 *  MAX_SCANNED_DOCUMENTS deliberately — nothing to lose by switching
 *  strategy beyond that point. */
export const MAP_REDUCE_DOCUMENT_THRESHOLD = MAX_SCANNED_DOCUMENTS

/** Bounds the number of map-phase LLM calls per candidate regardless of how
 *  many PDFs an auction actually has (10, 50, ...) — see
 *  buildDocumentSummaryInputs. Not env-configurable, consistent with the
 *  other hardcoded caps in this file. */
export const MAX_MAP_REDUCE_DOCUMENTS = 5

export interface DocumentSummaryInput<T> {
  /** Document label(s) this group covers — a single document's own label,
   *  or a synthesized one for the overflow bucket (see
   *  buildDocumentSummaryInputs). Threaded through to the reduce prompt so
  *  a failed/succeeded map call can be attributed to something readable. */
  label: string
  /** Exact document labels covered by this map call. */
  documentLabels?: string[]
  /** Documents not sent because the five-call cap or the run budget was hit. */
  deferredDocumentLabels?: string[]
  parts: DocumentLlmParts
}

/**
 * Derives the common LLM fields from already-fetched listing documents.
 * Callers retain control over fetching/text extraction, while scan detection,
 * page limits, text labelling and native-document assembly stay identical in
 * live enrichment and archived reprocessing.
 */
export async function buildDocumentLlmParts<T>(
  documents: Array<DocumentLlmSource<T>>,
  opts: {
    native: boolean
    renderPages?: (source: T, maxPages: number) => Promise<string[] | null>
    maxTextChars?: number
  },
): Promise<DocumentLlmParts> {
  if (opts.native) {
    const nativeDocuments = documents
      .filter((document): document is DocumentLlmSource<T> & { data: string } => !!document.data)
      .map(({ label, data }) => ({ label, data }))
    return {
      pdfText: null,
      pdfPageImages: null,
      pdfBytes: nativeDocuments.length === 1 ? nativeDocuments[0]!.data : null,
      pdfDocuments: nativeDocuments.length > 1 ? nativeDocuments : undefined,
    }
  }

  const combinedPdfText = documents
    .filter((document): document is DocumentLlmSource<T> & { text: string } => !!document.text?.trim())
    .map((document) => `=== ${document.label} ===\n${document.text}`)
    .join('\n\n') || null
  const pdfText = combinedPdfText && opts.maxTextChars != null
    ? compactDocumentText(combinedPdfText, opts.maxTextChars)
    : combinedPdfText
  const scannedDocuments = documents.filter(
    (document) => !document.text || document.text.trim().length < SCANNED_PDF_TEXT_THRESHOLD,
  )
  const pdfPageImages = scannedDocuments.length > 0 && opts.renderPages
    ? (
        await Promise.all(
          scannedDocuments
            .slice(0, MAX_SCANNED_DOCUMENTS)
            .map((document) => opts.renderPages!(document.source, MAX_PAGES_PER_DOCUMENT)),
        )
      ).flatMap((pages) => pages ?? []).slice(0, MAX_RENDERED_PAGES)
    : null

  return {
    pdfText,
    pdfPageImages,
    pdfBytes: null,
  }
}

function compactDocumentText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const marker = '\n\n[... Dokumentmitte aus Budgetgründen ausgelassen ...]\n\n'
  const available = Math.max(0, limit - marker.length)
  const firstPart = Math.floor(available * 0.7)
  const lastPart = available - firstPart
  return `${text.slice(0, firstPart)}${marker}${text.slice(-lastPart)}`.slice(0, limit)
}

function documentTextLength<T>(document: DocumentLlmSource<T>): number {
  return document.text?.trim() ? `=== ${document.label} ===\n${document.text}`.length : 0
}

function isScannedDocument<T>(document: DocumentLlmSource<T>): boolean {
  return !document.text || document.text.trim().length < SCANNED_PDF_TEXT_THRESHOLD
}

function canAppendToMapGroup<T>(
  docs: readonly DocumentLlmSource<T>[],
  document: DocumentLlmSource<T>,
): boolean {
  const scannedCount = docs.filter(isScannedDocument).length + (isScannedDocument(document) ? 1 : 0)
  if (scannedCount > MAX_SCANNED_DOCUMENTS) return false

  const textDocumentCount = docs.filter((doc) => documentTextLength(doc) > 0).length
  const currentTextLength = docs.reduce((total, doc) => total + documentTextLength(doc), 0) +
    Math.max(0, textDocumentCount - 1) * 2
  const nextTextLength = documentTextLength(document)
  const separatorLength = currentTextLength > 0 && nextTextLength > 0 ? 2 : 0
  return currentTextLength + separatorLength + nextTextLength <= MAX_MAP_REDUCE_DOCUMENT_TEXT_CHARS
}

/**
 * Map-reduce's map phase: splits documents into per-document
 * buildDocumentLlmParts() calls instead of one combined call, so each stays
 * small and complete instead of one shared call silently truncating/dropping
 * documents once there are more than a handful. Bounded to at most
 * MAX_MAP_REDUCE_DOCUMENTS groups regardless of input size. The first
 * MAX_MAP_REDUCE_DOCUMENTS - 1 documents each get their own group; the
 * remaining documents are packed into budget-safe groups. Documents that
 * cannot fit into the five groups are explicitly carried to the reduce
 * prompt as deferred instead of being silently dropped.
 */
export async function buildDocumentSummaryInputs<T>(
  documents: Array<DocumentLlmSource<T>>,
  opts: {
    native: boolean
    renderPages?: (source: T, maxPages: number) => Promise<string[] | null>
  },
): Promise<Array<DocumentSummaryInput<T>>> {
  if (documents.length === 0) return []
  const individualCount = Math.min(documents.length, MAX_MAP_REDUCE_DOCUMENTS - 1)
  const groups: Array<{ label: string; docs: Array<DocumentLlmSource<T>> }> =
    documents.slice(0, individualCount).map((doc) => ({ label: doc.label, docs: [doc] }))
  const overflow = documents.slice(individualCount)
  const overflowGroups: Array<{ label: string; docs: Array<DocumentLlmSource<T>> }> = []
  for (const document of overflow) {
    const current = overflowGroups.at(-1)
    const canAppend = current && current.docs.length > 0 && !opts.native && canAppendToMapGroup(current.docs, document)
    if (canAppend) {
      current.docs.push(document)
      current.label = `${current.docs.length} weitere Dokumente`
    } else {
      overflowGroups.push({ label: document.label, docs: [document] })
    }
  }
  groups.push(...overflowGroups)
  const selectedGroups = groups.slice(0, MAX_MAP_REDUCE_DOCUMENTS)
  const deferredDocumentLabels = groups
    .slice(MAX_MAP_REDUCE_DOCUMENTS)
    .flatMap((group) => group.docs.map((document) => document.label))
  const result: Array<DocumentSummaryInput<T>> = await Promise.all(
    selectedGroups.map(async (group) => ({
      label: group.label,
      documentLabels: group.docs.map((document) => document.label),
      parts: await buildDocumentLlmParts(group.docs, {
        ...opts,
        maxTextChars: MAX_MAP_REDUCE_DOCUMENT_TEXT_CHARS,
      }),
    })),
  )
  if (deferredDocumentLabels.length > 0 && result.length > 0) {
    result.at(-1)!.deferredDocumentLabels = deferredDocumentLabels
  }
  return result
}
