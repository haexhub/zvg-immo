import { getPool } from '~/server/utils/db'
import { readAuctionRecords } from '~/server/utils/auction-record'
import { classifyLlmStatus, type LlmStatusBucket } from '~/server/utils/llm-status'
import { ensureEnabledCountriesLoaded, listRegisteredCountries } from '~/server/crawlers/registry'

export interface LlmStatusItem {
  platform: string
  externalId: string
  title: string | null
  region: string
  caseNumber: string
  auctionDateIso: string | null
  llmFailures: number
  lastErrorMessage: string | null
}

export interface LlmStatusList {
  items: LlmStatusItem[]
  total: number
}

const BUCKETS: LlmStatusBucket[] = ['done', 'error', 'open']
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const SORT_FIELDS = ['platform', 'title', 'region', 'error', 'failures'] as const
type LlmStatusSort = typeof SORT_FIELDS[number]

/** Only looked up for the page actually being rendered — task_run_errors
 *  isn't scoped to a country, so scanning it for every candidate in a large
 *  country would cost far more than the handful of rows a page shows. */
async function lastErrorMessages(identities: { platform: string; externalId: string }[]): Promise<Map<string, string>> {
  const db = getPool()
  if (!db || identities.length === 0) return new Map()
  const { rows } = await db.query<{ platform: string; external_id: string; message: string }>(
    `SELECT DISTINCT ON (platform, external_id) platform, external_id, message
     FROM task_run_errors
     WHERE task = 'reprocess' AND (platform, external_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))
     ORDER BY platform, external_id, created_at DESC`,
    [identities.map((i) => i.platform), identities.map((i) => i.externalId)],
  )
  return new Map(rows.map((row) => [`${row.platform}:${row.external_id}`, row.message]))
}

export default defineEventHandler(async (event): Promise<LlmStatusList> => {
  const country = (getRouterParam(event, 'country') ?? '').trim().toLowerCase()
  if (!country) {
    throw createError({ statusCode: 400, statusMessage: 'country fehlt.' })
  }
  await ensureEnabledCountriesLoaded()
  if (!listRegisteredCountries().some((candidate) => candidate.code === country)) {
    throw createError({ statusCode: 400, statusMessage: `Unbekannte Länderquelle: ${country}` })
  }
  const query = getQuery(event)
  const bucket = String(query.bucket ?? '') as LlmStatusBucket
  if (!BUCKETS.includes(bucket)) {
    throw createError({ statusCode: 400, statusMessage: 'bucket muss done, error oder open sein.' })
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || DEFAULT_LIMIT))
  const offset = Math.max(0, Number(query.offset) || 0)
  const search = String(query.search ?? '').trim().toLocaleLowerCase()
  const sort = String(query.sort ?? '')
  const direction = String(query.direction ?? 'asc')
  if (sort && !SORT_FIELDS.includes(sort as LlmStatusSort)) {
    throw createError({ statusCode: 400, statusMessage: 'sort ist ungültig.' })
  }
  if (!['asc', 'desc'].includes(direction)) {
    throw createError({ statusCode: 400, statusMessage: 'direction muss asc oder desc sein.' })
  }

  const records = await readAuctionRecords(country, { includePhotos: false })
  const matching = records
    .filter((record) => classifyLlmStatus(record) === bucket)
    .filter((record) => !search || [
      record.auction.platform,
      record.auction.externalId,
      record.auction.title,
      record.auction.region,
      record.auction.caseNumber,
    ].some((value) => value?.toLocaleLowerCase().includes(search)))
    .sort((left, right) => {
      const field = (sort || 'platform') as LlmStatusSort
      const value = (record: typeof left): string | number => {
        if (field === 'title') return record.auction.title ?? ''
        if (field === 'region') return record.auction.region
        if (field === 'failures') return record.auction.processing?.llmFailures ?? 0
        // Error messages are only resolved for the visible error page below;
        // platform remains the stable, inexpensive order for that column.
        return record.auction.platform
      }
      const a = value(left)
      const b = value(right)
      const compared = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
      return direction === 'desc' ? -compared : compared
    })
  const page = matching.slice(offset, offset + limit)
  const errors = bucket === 'error'
    ? await lastErrorMessages(page.map((r) => ({ platform: r.auction.platform, externalId: r.auction.externalId })))
    : new Map<string, string>()

  return {
    total: matching.length,
    items: page.map((record) => ({
      platform: record.auction.platform,
      externalId: record.auction.externalId,
      title: record.auction.title,
      region: record.auction.region,
      caseNumber: record.auction.caseNumber,
      auctionDateIso: record.auction.auctionDateIso,
      llmFailures: record.auction.processing?.llmFailures ?? 0,
      lastErrorMessage: errors.get(`${record.auction.platform}:${record.auction.externalId}`) ?? null,
    })),
  }
})
