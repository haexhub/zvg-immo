// Dynamic sitemap: the static entry points plus every current (non-expired,
// non-withdrawn) auction detail page, reusing the same bounded public reader
// as /api/data/v1/auctions so this stays in lockstep with that contract.
import { canonicalAppOrigin } from '../utils/outbound-delivery'
import { readPublicAuctions } from '../utils/data-api-auction'

// Sitemap protocol hard cap (50,000 <url> entries per file) — safety rail,
// not expected to bind at current auction volume.
const MAX_URLS = 50_000
const PAGE_SIZE = 1000

function urlEntry(loc: string, lastmod?: string | null): string {
  const lastmodTag = lastmod ? `<lastmod>${lastmod.slice(0, 10)}</lastmod>` : ''
  return `<url><loc>${loc}</loc>${lastmodTag}</url>`
}

export default defineEventHandler(async (event) => {
  const origin = canonicalAppOrigin()
  const entries = [urlEntry(`${origin}/`), urlEntry(`${origin}/search`)]

  for (let page = 1; entries.length < MAX_URLS; page++) {
    const { data, total } = await readPublicAuctions({ includeWithdrawn: false, page, pageSize: PAGE_SIZE })
    for (const auction of data) {
      if (entries.length >= MAX_URLS) break
      entries.push(urlEntry(`${origin}${auction.appUrl}`, auction.lastUpdated))
    }
    if (page * PAGE_SIZE >= total) break
  }

  setHeader(event, 'content-type', 'application/xml; charset=utf-8')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`
})
