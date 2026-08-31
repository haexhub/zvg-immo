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

  const pdfText = documents
    .filter((document): document is DocumentLlmSource<T> & { text: string } => !!document.text?.trim())
    .map((document) => `=== ${document.label} ===\n${document.text}`)
    .join('\n\n') || null
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

/**
 * Map-reduce's map phase: splits documents into per-document
 * buildDocumentLlmParts() calls instead of one combined call, so each stays
 * small and complete instead of one shared call silently truncating/dropping
 * documents once there are more than a handful. Bounded to at most
 * MAX_MAP_REDUCE_DOCUMENTS groups regardless of input size — the first
 * MAX_MAP_REDUCE_DOCUMENTS - 1 documents each get their own group, anything
 * beyond that is folded into one final overflow group via the existing
 * multi-document combine logic (buildDocumentLlmParts unchanged), so a
 * 50-document auction still produces exactly MAX_MAP_REDUCE_DOCUMENTS map
 * calls, not 50.
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
  if (overflow.length > 0) {
    groups.push({
      label: overflow.length === 1 ? overflow[0]!.label : `${overflow.length} weitere Dokumente`,
      docs: overflow,
    })
  }
  return Promise.all(
    groups.map(async (group) => ({ label: group.label, parts: await buildDocumentLlmParts(group.docs, opts) })),
  )
}
