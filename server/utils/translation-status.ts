// Admin overview for the per-auction translation pipeline.  A translation is
// normally created lazily when a visitor opens an auction in another locale,
// but the status view is also the control surface for processing the complete
// backlog.  It therefore builds the set of *current* auction-version/target-
// language pairs first, then overlays any durable translation attempt.

import { CONTENT_TARGET_LANGS, isPassthroughLanguage, type ContentTargetLang } from '~/lib/content-language'
import { AUCTION_TRANSLATION_CLAIM_LEASE_MS } from './content-translation'
import { getPool } from './db'

export type TranslationStatusBucket = 'done' | 'error' | 'open' | 'pending'

export interface TranslationStatusCounts {
  done: number
  error: number
  open: number
  pending: number
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

interface TranslationCandidateFilters {
  country?: string
  lang?: ContentTargetLang
}

const BUCKET_BY_STATUS: Record<string, TranslationStatusBucket> = {
  completed: 'done',
  failed: 'error',
}

function isoOrNull(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : value
}

function isStalePending(candidate: TranslationCandidate): boolean {
  if (candidate.status !== 'pending' || candidate.startedAt == null) return false
  const startedAt = new Date(candidate.startedAt).getTime()
  return Number.isFinite(startedAt) && startedAt < Date.now() - AUCTION_TRANSLATION_CLAIM_LEASE_MS
}

/** A live (non-stale) pending claim gets its own bucket instead of being
 *  folded into 'open' — see readTranslationStatusByCountryAndLanguage, which
 *  used to drop these rows entirely rather than count them anywhere. A
 *  claim past its lease is treated as abandoned and falls back to 'open' so
 *  it stays retryable. */
function bucketOf(candidate: TranslationCandidate): TranslationStatusBucket {
  if (candidate.status == null) return 'open'
  if (candidate.status === 'pending') return isStalePending(candidate) ? 'open' : 'pending'
  return BUCKET_BY_STATUS[candidate.status] ?? 'open'
}

function isInBucket(candidate: TranslationCandidate, bucket: TranslationStatusBucket): boolean {
  return bucketOf(candidate) === bucket
}

/**
 * Returns every viable translation target for the latest detail version.
 * Filtering source-language passthroughs in TypeScript deliberately reuses
 * countryContentLanguage's CLDR inference, so enabling a new country keeps
 * this overview in lockstep with the public translation endpoint.
 */
async function readTranslationCandidates(filters: TranslationCandidateFilters = {}): Promise<TranslationCandidate[]> {
  const db = getPool()
  if (!db) return []
  const country = filters.country?.toLowerCase()
  const targetLanguages = filters.lang ? [filters.lang] : CONTENT_TARGET_LANGS
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
      WHERE ($2::text IS NULL OR lower(a.country) = $2)
        AND (a.title IS NOT NULL OR d.address IS NOT NULL OR d.description IS NOT NULL
          OR d.document_summary IS NOT NULL OR d.extraction_texts IS NOT NULL)`,
    [targetLanguages, country ?? null],
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
    const counts = out[country] = { done: 0, error: 0, open: 0, pending: 0, total: 0 }
    for (const languageCounts of Object.values(languages)) {
      if (!languageCounts) continue
      counts.done += languageCounts.done
      counts.error += languageCounts.error
      counts.open += languageCounts.open
      counts.pending += languageCounts.pending
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
    const counts = languages[candidate.lang] ?? (languages[candidate.lang] = { done: 0, error: 0, open: 0, pending: 0, total: 0 })
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
  const candidates = await readTranslationCandidates({ country: normalizedCountry, lang })
  return candidates
    .filter((candidate) => candidate.country === normalizedCountry && isInBucket(candidate, bucket) && (!lang || candidate.lang === lang))
    .map(({ platform, externalId, lang: targetLang }) => ({ platform, externalId, lang: targetLang }))
}

export async function readTranslationStatusList(
  country: string,
  bucket: TranslationStatusBucket,
  { limit = 50, offset = 0, search = '', sort, direction = 'asc', lang }: TranslationStatusListOptions = {},
): Promise<TranslationStatusList> {
  const normalizedCountry = country.toLowerCase()
  const filter = search.trim().toLocaleLowerCase()
  const candidates = (await readTranslationCandidates({ country: normalizedCountry, lang }))
    .filter((candidate) => candidate.country === normalizedCountry && isInBucket(candidate, bucket) && (!lang || candidate.lang === lang))
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
    if (field === 'startedAt') {
      const milliseconds = (candidate: TranslationCandidate): number => {
        if (candidate.startedAt == null) return Number.NEGATIVE_INFINITY
        const value = new Date(candidate.startedAt).getTime()
        return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
      }
      const result = milliseconds(left) - milliseconds(right)
        || left.platform.localeCompare(right.platform)
        || left.externalId.localeCompare(right.externalId)
        || left.lang.localeCompare(right.lang)
      return direction === 'desc' ? -result : result
    }
    const value = (candidate: TranslationCandidate): string => {
      if (field === 'platform') return candidate.platform
      if (field === 'title') return candidate.title ?? ''
      if (field === 'region') return candidate.region
      if (field === 'error') return candidate.lastErrorMessage ?? ''
      if (field === 'lang') return candidate.lang
      return ''
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
