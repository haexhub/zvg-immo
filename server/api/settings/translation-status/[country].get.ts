import { readTranslationStatusList, type TranslationStatusBucket, type TranslationStatusList } from '~/server/utils/translation-status'

const BUCKETS: TranslationStatusBucket[] = ['done', 'error', 'open']
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export default defineEventHandler(async (event): Promise<TranslationStatusList> => {
  const country = (getRouterParam(event, 'country') ?? '').trim().toLowerCase()
  if (!country) {
    throw createError({ statusCode: 400, statusMessage: 'country fehlt.' })
  }
  const query = getQuery(event)
  const bucket = String(query.bucket ?? '') as TranslationStatusBucket
  if (!BUCKETS.includes(bucket)) {
    throw createError({ statusCode: 400, statusMessage: 'bucket muss done, error oder open sein.' })
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || DEFAULT_LIMIT))
  const offset = Math.max(0, Number(query.offset) || 0)
  const search = String(query.search ?? '').trim()
  const sort = String(query.sort ?? '')
  const direction = String(query.direction ?? 'asc')
  if (sort && !['platform', 'title', 'region', 'error', 'lang', 'startedAt'].includes(sort)) {
    throw createError({ statusCode: 400, statusMessage: 'sort ist ungültig.' })
  }
  if (!['asc', 'desc'].includes(direction)) {
    throw createError({ statusCode: 400, statusMessage: 'direction muss asc oder desc sein.' })
  }
  return readTranslationStatusList(country, bucket, search || sort
    ? { limit, offset, search, sort: sort as 'platform' | 'title' | 'region' | 'error' | 'lang' | 'startedAt' | undefined, direction: direction as 'asc' | 'desc' }
    : { limit, offset })
})
