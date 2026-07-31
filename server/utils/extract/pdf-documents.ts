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

/**
 * Derives the common LLM fields from already-fetched listing documents.
 * Callers retain control over fetching/text extraction, while scan detection,
 * page limits, text labelling and native-document assembly stay identical in
 * live enrichment and archived reprocessing.
 */
function labelledText<T>(documents: Array<DocumentLlmSource<T>>): string | null {
  return documents
    .filter((document): document is DocumentLlmSource<T> & { text: string } => !!document.text?.trim())
    .map((document) => `=== ${document.label} ===\n${document.text}`)
    .join('\n\n') || null
}

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
      // Even in native mode a document may arrive already converted to text
      // (Docling Markdown, see server/utils/extract/docling.ts). Those carry
      // their text instead of their bytes, and a mixed set — some converted,
      // some not — has to stay complete, so both fields can be populated.
      pdfText: labelledText(documents),
      pdfPageImages: null,
      pdfBytes: nativeDocuments.length === 1 ? nativeDocuments[0]!.data : null,
      pdfDocuments: nativeDocuments.length > 1 ? nativeDocuments : undefined,
    }
  }

  const pdfText = labelledText(documents)
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
