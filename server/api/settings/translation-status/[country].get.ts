import { readTranslationStatusList, TRANSLATION_STATUS_SORTS, type TranslationStatusBucket, type TranslationStatusList, type TranslationStatusSort } from '~/server/utils/translation-status'
import { CONTENT_TARGET_LANGS, type ContentTargetLang } from '~/lib/content-language'

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
  const lang = String(query.lang ?? '')
  if (sort && !TRANSLATION_STATUS_SORTS.includes(sort as TranslationStatusSort)) {
    throw createError({ statusCode: 400, statusMessage: 'sort ist ungültig.' })
  }
  if (!['asc', 'desc'].includes(direction)) {
    throw createError({ statusCode: 400, statusMessage: 'direction muss asc oder desc sein.' })
  }
  if (lang && !CONTENT_TARGET_LANGS.includes(lang as ContentTargetLang)) {
    throw createError({ statusCode: 400, statusMessage: 'lang muss de oder en sein.' })
  }
  const options = search || sort
    ? { limit, offset, search, sort: (sort || undefined) as TranslationStatusSort | undefined, direction: direction as 'asc' | 'desc', lang: (lang || undefined) as ContentTargetLang | undefined }
    : { limit, offset }
  return readTranslationStatusList(country, bucket, lang
    ? { ...options, lang: lang as ContentTargetLang }
    : options)
})
