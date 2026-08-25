// dga-ag's Objektunterlagen link (detail.ts's extractObjectDocumentUrl) is a
// JWT-signed securedl URL valid ~25h from the crawl that captured it — the
// link stored on the auction goes stale long before most visitors click it.
// This re-fetches the object detail page live (same authenticated call as
// crawlers/dga-ag/detail.ts's enrichOne) to get a freshly-signed href and
// redirects there, so the link in the UI never goes stale.

import { readAuctionRecord } from '../../utils/auction-record'
import { isSafePathSegment } from '../../utils/path-segment'
import { fetchFreshObjectDocumentUrl } from '../../crawlers/dga-ag/detail'

export default defineEventHandler(async (event) => {
  const externalId = String(event.context.params?.externalId ?? '')
  if (!isSafePathSegment(externalId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid externalId' })
  }

  const record = await readAuctionRecord('dga-ag', externalId)
  const detailUrl = record?.auction.detailUrlUpstream ?? record?.auction.detailUrl
  if (!detailUrl) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }

  const documentUrl = await fetchFreshObjectDocumentUrl(detailUrl)
  if (!documentUrl) {
    throw createError({ statusCode: 404, statusMessage: 'Objektunterlagen not available' })
  }
  return sendRedirect(event, documentUrl, 302)
})
