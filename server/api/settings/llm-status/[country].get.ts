import { getPool } from '~/server/utils/db'
import { iterateAuctionRecords } from '~/server/utils/auction-record'
import { classifyLlmStatus, isLlmExtractionInScope, type LlmStatusBucket } from '~/server/utils/llm-status'
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

/** What is kept per match while streaming, before the error message is resolved for the page. */
type LlmStatusMatch = Omit<LlmStatusItem, 'lastErrorMessage'>

export interface LlmStatusList {
  items: LlmStatusItem[]
  total: number
}

const BUCKETS: LlmStatusBucket[] = ['done', 'error', 'open', 'pending']
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
// `error` is intentionally unsupported: last error messages are resolved only
// for the visible page below, so the full set cannot be ordered by that column.
const SORT_FIELDS = ['platform', 'title', 'region', 'failures'] as const
type LlmStatusSort = typeof SORT_FIELDS[number]

/** Only looked up for the page actually being rendered — llm_usage_events
 *  isn't scoped to a country, so scanning it for every candidate in a large
 *  country would cost far more than the handful of rows a page shows.
 *  Sources from llm_usage_events rather than task_run_errors so this matches
 *  the per-run failures shown on the auction technical page (same table,
 *  same "last failed extraction call" concept) instead of drifting from it —
 *  admin-triggered trial runs are excluded since they never affect llmFailures
 *  or this bucket's classification in the first place. */
async function lastErrorMessages(identities: { platform: string; externalId: string }[]): Promise<Map<string, string>> {
  const db = getPool()
  if (!db || identities.length === 0) return new Map()
  const { rows } = await db.query<{ platform: string; external_id: string; error_message: string | null }>(
    `SELECT DISTINCT ON (platform, external_id) platform, external_id, error_message
     FROM llm_usage_events
     WHERE task = 'extraction' AND status = 'failed' AND source IS DISTINCT FROM 'admin-trial'
       AND (platform, external_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))
     ORDER BY platform, external_id, occurred_at DESC`,
    [identities.map((i) => i.platform), identities.map((i) => i.externalId)],
  )
  return new Map(
    rows
      .filter((row): row is typeof row & { error_message: string } => row.error_message != null)
      .map((row) => [`${row.platform}:${row.external_id}`, row.error_message]),
  )
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
    throw createError({ statusCode: 400, statusMessage: 'bucket muss done, error, open oder pending sein.' })
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

  // Streamed, keeping only a slim projection of the matches: a country can hold
  // tens of thousands of records and this page is requested repeatedly.
  const matching: LlmStatusMatch[] = []
  for await (const record of iterateAuctionRecords(country, { includePhotos: false })) {
    if (!isLlmExtractionInScope(record) || classifyLlmStatus(record) !== bucket) continue
    const { auction } = record
    if (search && ![auction.platform, auction.externalId, auction.title, auction.region, auction.caseNumber]
      .some((value) => value?.toLocaleLowerCase().includes(search))) continue
    matching.push({
      platform: auction.platform,
      externalId: auction.externalId,
      title: auction.title,
      region: auction.region,
      caseNumber: auction.caseNumber,
      auctionDateIso: auction.auctionDateIso,
      llmFailures: auction.processing?.llmFailures ?? 0,
    })
  }
  matching.sort((left, right) => {
    const field = (sort || 'platform') as LlmStatusSort
    const value = (item: LlmStatusMatch): string | number => {
      if (field === 'title') return item.title ?? ''
      if (field === 'region') return item.region
      if (field === 'failures') return item.llmFailures
      // Error messages are only resolved for the visible error page below;
      // platform remains the stable, inexpensive order for that column.
      return item.platform
    }
    const a = value(left)
    const b = value(right)
    const compared = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
    return direction === 'desc' ? -compared : compared
  })
  const page = matching.slice(offset, offset + limit)
  const errors = bucket === 'error'
    ? await lastErrorMessages(page.map((item) => ({ platform: item.platform, externalId: item.externalId })))
    : new Map<string, string>()

  return {
    total: matching.length,
    items: page.map((item) => ({
      ...item,
      lastErrorMessage: errors.get(`${item.platform}:${item.externalId}`) ?? null,
    })),
  }
})
