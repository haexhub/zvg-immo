import type { CrawlResult } from '~/types/auction'
import { crawlAll, crawlSingle } from '../crawlers/registry'

export default defineEventHandler(async (event): Promise<CrawlResult> => {
  const query = getQuery(event)
  const land = (typeof query.land === 'string' ? query.land : 'sn').toLowerCase()
  const immobilienOnly = query.immo !== '0'
  try {
    if (land === 'all') {
      return await crawlAll({ immobilienOnly })
    }
    return await crawlSingle({ bundesland: land, immobilienOnly })
  } catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: 'Crawler-Quelle nicht erreichbar',
      data: { detail: (err as Error).message },
    })
  }
})
