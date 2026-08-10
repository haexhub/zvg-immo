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
  const requestedLimit = Number(query.limit ?? DEFAULT_LIMIT)
  const requestedOffset = Number(query.offset ?? 0)
  if (!Number.isInteger(requestedLimit) || !Number.isInteger(requestedOffset)) {
    throw createError({ statusCode: 400, statusMessage: 'limit und offset müssen ganze Zahlen sein.' })
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, requestedLimit))
  const offset = Math.max(0, requestedOffset)
  return readCrawlStatusList(country, bucket, { limit, offset })
})
