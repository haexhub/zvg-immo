// Live crawl-time document preparation: fetches attachments over HTTP (with
// dga-ag/zvg-portal-specific source resolution and retry-on-login-redirect),
// as opposed to llm-documents.ts's archived-reprocess path, which reads
// already-archived blobs via storage-download.ts. Split out of
// llm-documents.ts purely to keep both files under the project's 500-line
// module-size ceiling — prepareLiveLlmDocuments is re-exported from there so
// callers (enrich-worker.ts) import from the same place as before.

import type { Attachment } from '~/types/auction'
import { getDgaAgSessionCookie, isDgaAgLoginRedirect } from '~/server/crawlers/dga-ag/session'
import type { ArchivedDocumentSetItem, DocumentIdentity } from '../raw-archive'
import {
  attachmentLabel,
  formatHint,
  pickAllLlmDocumentAttachments,
  prepareDocument,
  type PreparedAttachmentDocument,
} from './llm-documents'
import { resolveAttachmentSource } from './pdf-text'
import { fetchPublicUrl } from './public-fetch'

export interface ArchivedLiveDocuments {
  documentSetItems: ArchivedDocumentSetItem[]
  documentSetComplete: boolean
  /** One entry per candidate whose fetch didn't yield bytes — the reason
   *  fetchAttachmentBytes used to swallow silently. Undefined when complete. */
  errors?: string[]
}

const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024

function acceptForHint(format: ReturnType<typeof formatHint>): string {
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

interface FetchedAttachment {
  bytes: Buffer | null
  error?: string
}

async function fetchAttachmentBytesOnce(
  url: string,
  headers: Record<string, string>,
): Promise<FetchedAttachment & { finalUrl: string | null }> {
  let finalUrl: string | null = null
  try {
    const res = await fetchPublicUrl(url, { headers, signal: AbortSignal.timeout(30_000) })
    finalUrl = res.url || null
    if (!res.ok) return { bytes: null, error: `HTTP ${res.status}`, finalUrl }
    const contentLength = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_BYTES) {
      await res.body?.cancel().catch(() => undefined)
      return { bytes: null, error: `attachment too large (${contentLength} bytes)`, finalUrl }
    }
    if (!res.body) return { bytes: null, error: 'empty response body', finalUrl }
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
        return { bytes: null, error: `attachment too large (>${MAX_ATTACHMENT_BYTES} bytes)`, finalUrl }
      }
      chunks.push(Buffer.from(value))
    }
    return { bytes: Buffer.concat(chunks, total), finalUrl }
  } catch (err) {
    return { bytes: null, error: (err as Error).message, finalUrl }
  }
}

async function fetchAttachmentBytes(att: Attachment): Promise<FetchedAttachment> {
  const accept = acceptForHint(formatHint(att))
  const first = await resolveAttachmentSource(att.proxyUrl, accept)
  const firstResult = await fetchAttachmentBytesOnce(first.url, first.headers)
  if (!isDgaAgLoginRedirect(att.proxyUrl, firstResult.finalUrl)) return firstResult
  await getDgaAgSessionCookie({ forceRefresh: true })
  const retry = await resolveAttachmentSource(att.proxyUrl, accept)
  const retried = await fetchAttachmentBytesOnce(retry.url, retry.headers)
  // A failed re-login backs off and yields no cookie instead of throwing
  // (session.ts), so the anonymous retry can land on the login page again
  // with HTTP 200 — never archive that page as the attachment.
  if (isDgaAgLoginRedirect(att.proxyUrl, retried.finalUrl)) return { bytes: null, error: 'dga-ag login required' }
  return retried
}

export async function prepareLiveLlmDocuments(
  attachments: readonly Attachment[],
  identity: DocumentIdentity,
  capturedAt: string,
): Promise<ArchivedLiveDocuments> {
  const candidates = pickAllLlmDocumentAttachments(attachments)
  const fetchErrors: string[] = []
  const prepared = (
    await Promise.all(candidates.map(async (attachment, ordinal) => {
      const { bytes, error } = await fetchAttachmentBytes(attachment)
      if (!bytes) {
        if (error) fetchErrors.push(`${attachmentLabel(attachment)}: ${error}`)
        return null
      }
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
    errors: fetchErrors.length > 0 ? fetchErrors : undefined,
  }
}
