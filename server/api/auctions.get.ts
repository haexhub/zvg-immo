import type { CrawlResult } from '~/types/auction'
import { crawlAll, crawlSingle } from '../crawlers/registry'

export default defineEventHandler(async (event): Promise<CrawlResult> => {
  const query = getQuery(event)
  const country = typeof query.country === 'string' ? query.country.toLowerCase() : 'all'
  const region = typeof query.region === 'string' ? query.region.toLowerCase() : 'all'
  const immobilienOnly = query.immo !== '0'
  try {
    if (country === 'all') {
      // All countries, all regions.
      return await crawlAll({ immobilienOnly })
    }
    if (region === 'all') {
      // One country, all its regions.
      return await crawlAll({ immobilienOnly, country })
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
