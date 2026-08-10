import { getPool } from '~/server/utils/db'
import { readAuctionRecords } from '~/server/utils/auction-record'
import { classifyLlmStatus, type LlmStatusBucket } from '~/server/utils/llm-status'

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
  const query = getQuery(event)
  const bucket = String(query.bucket ?? '') as LlmStatusBucket
  if (!BUCKETS.includes(bucket)) {
    throw createError({ statusCode: 400, statusMessage: 'bucket muss done, error oder open sein.' })
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || DEFAULT_LIMIT))
  const offset = Math.max(0, Number(query.offset) || 0)

  const records = await readAuctionRecords(country, { includePhotos: false })
  const matching = records.filter((record) => classifyLlmStatus(record) === bucket)
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
