import type { Auction } from '~/types/auction'
import { ZVG_BASE } from '~/server/crawlers/zvg-portal/constants'

function originalZvgDocumentUrl(value: string): string {
  if (!value.startsWith('/api/zvg-proxy?')) return value
  const query = value.slice(value.indexOf('?') + 1)
  return `${ZVG_BASE}/index.php?${query}`
}

/**
 * Removes the retired same-origin HTML proxy from persisted legacy records.
 * Documents keep pointing at the original source; upstream HTML detail pages
 * are crawler metadata only and are not exposed as public app links.
 */
export function normalizePublicAuctionLinks(auction: Auction): Auction {
  if (auction.platform !== 'zvg-portal') return auction
  auction.detailUrl = null
  auction.pdfUrl = auction.pdfUrlUpstream
    ? originalZvgDocumentUrl(auction.pdfUrlUpstream)
    : auction.pdfUrl
      ? originalZvgDocumentUrl(auction.pdfUrl)
      : null
  for (const attachment of Array.isArray(auction.attachments) ? auction.attachments : []) {
    attachment.proxyUrl = originalZvgDocumentUrl(attachment.proxyUrl)
  }
  return auction
}
