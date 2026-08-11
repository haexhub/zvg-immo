// Admin overview for the lazy per-auction translation pipeline
// (auction_translations — see server/db/schema/translations.ts), per country.
// Unlike crawl/LLM status, there is no proactive backlog of "auctions still
// needing translation": a row only exists once a visitor viewed an auction in
// a non-source language (or an admin retried it), so the universe here is
// translation attempts, not all auctions. status already lives directly on
// the row (no separate error log to join, unlike task_run_errors for crawl).

import { getPool } from './db'
import { AUCTION_TRANSLATION_CLAIM_LEASE } from './content-translation'
import type { ContentTargetLang } from '~/lib/content-language'

export type TranslationStatusBucket = 'done' | 'error' | 'open'

export interface TranslationStatusCounts {
  done: number
  error: number
  open: number
  total: number
}

export interface TranslationStatusItem {
  platform: string
  externalId: string
  title: string | null
  region: string
  caseNumber: string
  lang: string
  lastErrorMessage: string | null
  startedAt: string
}

export interface TranslationStatusList {
  items: TranslationStatusItem[]
  total: number
}

export const TRANSLATION_STATUS_SORTS = ['platform', 'title', 'region', 'error', 'lang', 'startedAt'] as const
export type TranslationStatusSort = typeof TRANSLATION_STATUS_SORTS[number]

export interface TranslationStatusListOptions {
  limit?: number
  offset?: number
  search?: string
  sort?: TranslationStatusSort
  direction?: 'asc' | 'desc'
}

const BUCKET_BY_STATUS: Record<string, TranslationStatusBucket> = {
  completed: 'done',
  failed: 'error',
  pending: 'open',
}

function isoOrNull(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : value
}

export async function readTranslationStatusByCountry(): Promise<Record<string, TranslationStatusCounts>> {
  const db = getPool()
  if (!db) return {}
  const { rows } = await db.query<{ country: string; status: string; count: string }>(
    `SELECT a.country, t.status, count(*) AS count
     FROM auction_translations t
     JOIN auctions a ON a.platform = t.platform AND a.external_id = t.external_id
     GROUP BY a.country, t.status`,
  )
  const out: Record<string, TranslationStatusCounts> = {}
  for (const row of rows) {
    const bucket = BUCKET_BY_STATUS[row.status]
    if (!bucket) continue
    const counts = out[row.country] ?? (out[row.country] = { done: 0, error: 0, open: 0, total: 0 })
    const n = Number(row.count)
    counts[bucket] += n
    counts.total += n
  }
  return out
}

/** Every retryable (auction, lang) identity in one country/bucket,
 *  unpaginated. A pending row is retried only after its claim lease has
 *  expired: claimAuctionTranslation cannot safely take an active claim over,
 *  so including it here made the bulk endpoint report a successful retry
 *  without actually starting one. */
export async function readTranslationStatusIdentities(
  country: string,
  bucket: TranslationStatusBucket,
): Promise<{ platform: string; externalId: string; lang: ContentTargetLang }[]> {
  const db = getPool()
  if (!db) return []
  const status = Object.entries(BUCKET_BY_STATUS).find(([, b]) => b === bucket)?.[0]
  if (!status) return []
  const pendingLeaseClause = bucket === 'open'
    ? ' AND t.started_at < now() - $3::interval'
    : ''
  const { rows } = await db.query<{ platform: string; external_id: string; lang: string }>(
    `SELECT a.platform, a.external_id, t.lang
     FROM auction_translations t
     JOIN auctions a ON a.platform = t.platform AND a.external_id = t.external_id
     WHERE a.country = $1 AND t.status = $2${pendingLeaseClause}`,
    bucket === 'open'
      ? [country, status, AUCTION_TRANSLATION_CLAIM_LEASE]
      : [country, status],
  )
  return rows.map((row) => ({ platform: row.platform, externalId: row.external_id, lang: row.lang as ContentTargetLang }))
}

export async function readTranslationStatusList(
  country: string,
  bucket: TranslationStatusBucket,
  { limit = 50, offset = 0, search = '', sort, direction = 'asc' }: TranslationStatusListOptions = {},
): Promise<TranslationStatusList> {
  const db = getPool()
  if (!db) return { items: [], total: 0 }
  const status = Object.entries(BUCKET_BY_STATUS).find(([, b]) => b === bucket)?.[0]
  if (!status) return { items: [], total: 0 }
  const filter = search.trim()
  if (filter || sort) {
    const orderBy: Record<TranslationStatusSort, string> = {
      platform: 'a.platform', title: 'a.title', region: 'a.region', error: 't.error_message', lang: 't.lang', startedAt: 't.started_at',
    }
    const params: (string | number)[] = [country, status]
    const filterClause = filter
      ? ` AND concat_ws(' ', a.platform, a.external_id, a.title, a.region, a.case_number, t.lang, t.error_message) ILIKE $${params.push(`%${filter}%`)}`
      : ''
    const order = sort
      ? `${orderBy[sort]} ${direction === 'desc' ? 'DESC' : 'ASC'}, a.platform ASC, a.external_id ASC`
      : 't.started_at DESC, a.platform ASC, a.external_id ASC'
    const pageParams = [...params, limit, offset]
    const [{ rows }, { rows: countRows }] = await Promise.all([
      db.query<{
        platform: string; external_id: string; title: string | null; region: string; case_number: string
        lang: string; error_message: string | null; started_at: Date | string
      }>(
        `SELECT a.platform, a.external_id, a.title, a.region, a.case_number, t.lang, t.error_message, t.started_at
         FROM auction_translations t JOIN auctions a ON a.platform = t.platform AND a.external_id = t.external_id
         WHERE a.country = $1 AND t.status = $2${filterClause}
         ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        pageParams,
      ),
      db.query<{ count: string }>(
        `SELECT count(*) AS count FROM auction_translations t JOIN auctions a ON a.platform = t.platform AND a.external_id = t.external_id
         WHERE a.country = $1 AND t.status = $2${filterClause}`,
        params,
      ),
    ])
    return {
      items: rows.map((row) => ({
        platform: row.platform, externalId: row.external_id, title: row.title, region: row.region,
        caseNumber: row.case_number, lang: row.lang, lastErrorMessage: row.error_message, startedAt: isoOrNull(row.started_at)!,
      })),
      total: Number(countRows[0]?.count ?? 0),
    }
  }
  const [{ rows }, { rows: countRows }] = await Promise.all([
    db.query<{
      platform: string
      external_id: string
      title: string | null
      region: string
      case_number: string
      lang: string
      error_message: string | null
      started_at: Date | string
    }>(
      `SELECT a.platform, a.external_id, a.title, a.region, a.case_number,
              t.lang, t.error_message, t.started_at
       FROM auction_translations t
       JOIN auctions a ON a.platform = t.platform AND a.external_id = t.external_id
       WHERE a.country = $1 AND t.status = $2
       ORDER BY t.started_at DESC LIMIT $3 OFFSET $4`,
      [country, status, limit, offset],
    ),
    db.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM auction_translations t
       JOIN auctions a ON a.platform = t.platform AND a.external_id = t.external_id
       WHERE a.country = $1 AND t.status = $2`,
      [country, status],
    ),
  ])
  return {
    items: rows.map((row) => ({
      platform: row.platform,
      externalId: row.external_id,
      title: row.title,
      region: row.region,
      caseNumber: row.case_number,
      lang: row.lang,
      lastErrorMessage: row.error_message,
      startedAt: isoOrNull(row.started_at)!,
    })),
    total: Number(countRows[0]?.count ?? 0),
  }
}
