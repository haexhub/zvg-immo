// Static crawl policy. /api/ is disallowed generally (JSON, no SEO value —
// the documented Daten-API's own consumers call it directly and don't obey
// robots.txt anyway), except auction-image, which sitemap.xml/JSON-LD
// reference as image URLs and should stay crawlable for image search.
import { canonicalAppOrigin } from '../utils/outbound-delivery'

export default defineEventHandler((event) => {
  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return [
    'User-agent: *',
    'Disallow: /admin',
    'Disallow: /settings',
    'Disallow: /account',
    'Disallow: /login',
    'Disallow: /signup',
    'Allow: /api/auction-image/',
    'Disallow: /api/',
    '',
    `Sitemap: ${canonicalAppOrigin()}/sitemap.xml`,
    '',
  ].join('\n')
})
