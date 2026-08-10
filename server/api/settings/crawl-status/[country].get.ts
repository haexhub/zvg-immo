import { readCrawlStatusList, type CrawlStatusBucket, type CrawlStatusList } from '~/server/utils/crawl-status'

const BUCKETS: CrawlStatusBucket[] = ['done', 'error', 'open']
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export default defineEventHandler(async (event): Promise<CrawlStatusList> => {
  const country = (getRouterParam(event, 'country') ?? '').trim().toLowerCase()
  if (!country) {
    throw createError({ statusCode: 400, statusMessage: 'country fehlt.' })
  }
  const query = getQuery(event)
  const bucket = String(query.bucket ?? '') as CrawlStatusBucket
  if (!BUCKETS.includes(bucket)) {
    throw createError({ statusCode: 400, statusMessage: `bucket muss done, error oder open sein.` })
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || DEFAULT_LIMIT))
  const offset = Math.max(0, Number(query.offset) || 0)
  return readCrawlStatusList(country, bucket, { limit, offset })
})
