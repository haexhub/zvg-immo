// Dynamic sitemap: the static entry points plus every current (non-expired,
// non-withdrawn) auction detail page, reusing the collection filter of
// /api/data/v1/auctions so this stays in lockstep with that contract. The
// response is SWR-cached via routeRules in nuxt.config.ts.
import { canonicalAppOrigin } from '../utils/outbound-delivery'
import { readPublicAuctionLinks } from '../utils/data-api-auction'

// Sitemap protocol hard cap (50,000 <url> entries per file) — safety rail,
// not expected to bind at current auction volume.
const MAX_URLS = 50_000

function urlEntry(loc: string, lastmod?: string | null): string {
  const lastmodTag = lastmod ? `<lastmod>${lastmod.slice(0, 10)}</lastmod>` : ''
  return `<url><loc>${loc}</loc>${lastmodTag}</url>`
}

export default defineEventHandler(async (event) => {
  const origin = canonicalAppOrigin()
  const entries = [urlEntry(`${origin}/`), urlEntry(`${origin}/search`)]
  for (const link of await readPublicAuctionLinks(MAX_URLS - entries.length)) {
    entries.push(urlEntry(`${origin}${link.appUrl}`, link.lastUpdated))
  }

  setHeader(event, 'content-type', 'application/xml; charset=utf-8')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`
})
