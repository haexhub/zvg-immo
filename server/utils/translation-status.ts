// Admin overview for the per-auction translation pipeline.  A translation is
// normally created lazily when a visitor opens an auction in another locale,
// but the status view is also the control surface for processing the complete
// backlog.  It therefore builds the set of *current* auction-version/target-
// language pairs first, then overlays any durable translation attempt.

import { CONTENT_TARGET_LANGS, isPassthroughLanguage, type ContentTargetLang } from '~/lib/content-language'
import { AUCTION_TRANSLATION_CLAIM_LEASE_MS } from './content-translation'
import { getPool } from './db'

export type TranslationStatusBucket = 'done' | 'error' | 'open'

export interface TranslationStatusCounts {
  done: number
  error: number
  open: number
  total: number
}

export type TranslationStatusByLanguage = Partial<Record<ContentTargetLang, TranslationStatusCounts>>

export interface TranslationStatusItem {
  platform: string
  externalId: string
  title: string | null
  region: string
  caseNumber: string
  lang: string
  lastErrorMessage: string | null
  /** null means this target-language pair has not been started yet. */
  startedAt: string | null
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
  lang?: ContentTargetLang
}

interface TranslationCandidate {
  country: string
  platform: string
  externalId: string
  title: string | null
  region: string
  caseNumber: string
  lang: ContentTargetLang
  status: 'pending' | 'completed' | 'failed' | null
  lastErrorMessage: string | null
  startedAt: Date | string | null
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

function bucketOf(candidate: TranslationCandidate): TranslationStatusBucket {
  return candidate.status == null ? 'open' : (BUCKET_BY_STATUS[candidate.status] ?? 'open')
}

function isStalePending(candidate: TranslationCandidate): boolean {
  if (candidate.status !== 'pending' || candidate.startedAt == null) return false
  const startedAt = new Date(candidate.startedAt).getTime()
  return Number.isFinite(startedAt) && startedAt < Date.now() - AUCTION_TRANSLATION_CLAIM_LEASE_MS
}

/**
 * Returns every viable translation target for the latest detail version.
 * Filtering source-language passthroughs in TypeScript deliberately reuses
 * countryContentLanguage's CLDR inference, so enabling a new country keeps
 * this overview in lockstep with the public translation endpoint.
 */
async function readTranslationCandidates(): Promise<TranslationCandidate[]> {
  const db = getPool()
  if (!db) return []
  const { rows } = await db.query<{
    country: string
    platform: string
    external_id: string
    title: string | null
    region: string
    case_number: string
    lang: string
    status: 'pending' | 'completed' | 'failed' | null
    error_message: string | null
    started_at: Date | string | null
  }>(
    `SELECT a.country, a.platform, a.external_id, a.title, a.region, a.case_number,
            target.lang, t.status, t.error_message, t.started_at
       FROM auctions a
       JOIN auction_details d
         ON d.platform = a.platform AND d.external_id = a.external_id AND d.is_latest = true
       CROSS JOIN unnest($1::text[]) AS target(lang)
       LEFT JOIN auction_translations t
         ON t.platform = a.platform AND t.external_id = a.external_id
        AND t.version = d.version AND t.lang = target.lang
      WHERE a.title IS NOT NULL OR d.address IS NOT NULL OR d.description IS NOT NULL
         OR d.document_summary IS NOT NULL OR d.extraction_texts IS NOT NULL`,
    [CONTENT_TARGET_LANGS],
  )
  return rows
    .filter((row) => !isPassthroughLanguage(row.country, row.lang as ContentTargetLang))
    .map((row) => ({
      country: row.country.toLowerCase(),
      platform: row.platform,
      externalId: row.external_id,
      title: row.title,
      region: row.region,
      caseNumber: row.case_number,
      lang: row.lang as ContentTargetLang,
      status: row.status,
      lastErrorMessage: row.error_message,
      startedAt: row.started_at,
    }))
}

export async function readTranslationStatusByCountry(): Promise<Record<string, TranslationStatusCounts>> {
  const byLanguage = await readTranslationStatusByCountryAndLanguage()
  const out: Record<string, TranslationStatusCounts> = {}
  for (const [country, languages] of Object.entries(byLanguage)) {
    const counts = out[country] = { done: 0, error: 0, open: 0, total: 0 }
    for (const languageCounts of Object.values(languages)) {
      if (!languageCounts) continue
      counts.done += languageCounts.done
      counts.error += languageCounts.error
      counts.open += languageCounts.open
      counts.total += languageCounts.total
    }
  }
  return out
}

/** Same status universe as the aggregate, retained by target language for the
 * country overview's separate German/English cards. */
export async function readTranslationStatusByCountryAndLanguage(): Promise<Record<string, TranslationStatusByLanguage>> {
  const candidates = await readTranslationCandidates()
  const out: Record<string, TranslationStatusByLanguage> = {}
  for (const candidate of candidates) {
    const languages = out[candidate.country] ?? (out[candidate.country] = {})
    const counts = languages[candidate.lang] ?? (languages[candidate.lang] = { done: 0, error: 0, open: 0, total: 0 })
    counts[bucketOf(candidate)]++
    counts.total++
  }
  return out
}

/** Every retryable (auction, lang) identity in one country/bucket.
 * Unstarted candidates are retryable open entries; active pending claims are
 * intentionally excluded until their lease expires. */
export async function readTranslationStatusIdentities(
  country: string,
  bucket: TranslationStatusBucket,
  lang?: ContentTargetLang,
): Promise<{ platform: string; externalId: string; lang: ContentTargetLang }[]> {
  const normalizedCountry = country.toLowerCase()
  const candidates = await readTranslationCandidates()
  return candidates
    .filter((candidate) => candidate.country === normalizedCountry && bucketOf(candidate) === bucket && (!lang || candidate.lang === lang))
    .filter((candidate) => bucket !== 'open' || candidate.status == null || isStalePending(candidate))
    .map(({ platform, externalId, lang }) => ({ platform, externalId, lang }))
}

export async function readTranslationStatusList(
  country: string,
  bucket: TranslationStatusBucket,
  { limit = 50, offset = 0, search = '', sort, direction = 'asc', lang }: TranslationStatusListOptions = {},
): Promise<TranslationStatusList> {
  const normalizedCountry = country.toLowerCase()
  const filter = search.trim().toLocaleLowerCase()
  const candidates = (await readTranslationCandidates())
    .filter((candidate) => candidate.country === normalizedCountry && bucketOf(candidate) === bucket && (!lang || candidate.lang === lang))
    .filter((candidate) => !filter || [
      candidate.platform,
      candidate.externalId,
      candidate.title,
      candidate.region,
      candidate.caseNumber,
      candidate.lang,
      candidate.lastErrorMessage,
    ].some((value) => value?.toLocaleLowerCase().includes(filter)))

  const field = sort ?? 'startedAt'
  candidates.sort((left, right) => {
    const value = (candidate: TranslationCandidate): string => {
      if (field === 'platform') return candidate.platform
      if (field === 'title') return candidate.title ?? ''
      if (field === 'region') return candidate.region
      if (field === 'error') return candidate.lastErrorMessage ?? ''
      if (field === 'lang') return candidate.lang
      return isoOrNull(candidate.startedAt) ?? ''
    }
    const result = value(left).localeCompare(value(right))
      || left.platform.localeCompare(right.platform)
      || left.externalId.localeCompare(right.externalId)
      || left.lang.localeCompare(right.lang)
    return direction === 'desc' ? -result : result
  })

  return {
    total: candidates.length,
    items: candidates.slice(offset, offset + limit).map((candidate) => ({
      platform: candidate.platform,
      externalId: candidate.externalId,
      title: candidate.title,
      region: candidate.region,
      caseNumber: candidate.caseNumber,
      lang: candidate.lang,
      lastErrorMessage: candidate.lastErrorMessage,
      startedAt: isoOrNull(candidate.startedAt),
    })),
  }
}
