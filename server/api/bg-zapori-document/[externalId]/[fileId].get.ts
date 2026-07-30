// zapori.mjs.bg's attachment blobs are served behind a signed URL
// (`?t=<timestamp>&h=<hash>`) that expires — the link stored on the auction
// at enrich time goes stale long before the auction itself concludes. This
// re-fetches the announcement live (same call as crawlers/bg/detail.ts's
// enrichOne) to get a fresh signed href for the requested attachment and
// redirects there, so the link in the UI never goes stale.

import { BG_API_BASE, UA } from '../../../crawlers/bg/constants'
import { isSafePathSegment } from '../../../utils/path-segment'

interface BgAttachmentBlob {
  href: string | null
}

interface BgAttachment {
  id: number
  blob: BgAttachmentBlob | null
}

interface BgDetail {
  attachments: BgAttachment[] | null
}

export default defineEventHandler(async (event) => {
  const externalId = String(event.context.params?.externalId ?? '')
  const fileId = String(event.context.params?.fileId ?? '')
  if (!isSafePathSegment(externalId) || !isSafePathSegment(fileId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid externalId/fileId' })
  }

  const res = await fetch(`${BG_API_BASE}/announcements/${externalId}`, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    throw createError({ statusCode: 502, statusMessage: `zapori.mjs.bg detail: HTTP ${res.status}` })
  }
  const d = (await res.json()) as BgDetail
  const href = d.attachments?.find((att) => String(att.id) === fileId)?.blob?.href
  if (!href) {
    throw createError({ statusCode: 404, statusMessage: 'attachment not found' })
  }
  return sendRedirect(event, href, 302)
})
