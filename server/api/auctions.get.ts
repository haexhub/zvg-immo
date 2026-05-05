import type { CrawlResult } from '~/types/auction'
import { crawlAll, crawlSingle } from '../crawlers/registry'

export default defineEventHandler(async (event): Promise<CrawlResult> => {
  const query = getQuery(event)
  const country = typeof query.country === 'string' ? query.country.toLowerCase() : 'all'
  const region = typeof query.region === 'string' ? query.region.toLowerCase() : 'all'
  const immobilienOnly = query.immo !== '0'
  try {
    if (country === 'all') {
      // All countries, all regions. Detail enrichment off — a country-wide
      // crawl across every platform would otherwise issue thousands of
      // detail fetches and time out behind Traefik.
      return await crawlAll({ immobilienOnly, enrichDetails: false })
    }
    if (region === 'all') {
      // One country, all its regions. Same reasoning as above.
      return await crawlAll({ immobilienOnly, country, enrichDetails: false })
    }
    return await crawlSingle({ country, region, immobilienOnly })
  } catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: 'Crawler-Quelle nicht erreichbar',
      data: { detail: (err as Error).message },
    })
  }
})
