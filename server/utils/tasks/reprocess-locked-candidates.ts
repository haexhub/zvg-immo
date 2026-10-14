import { getPool } from '~/server/utils/db'
import { MAX_LLM_FAILURES } from '~/lib/llm-limits'
import type { Candidate, ReprocessOptions } from './reprocess-input'

/**
 * Candidates for a `failedOnly` run: auctions locked out of the LLM pipeline
 * (llm_failures >= MAX_LLM_FAILURES) that never got a successful extraction.
 *
 * Selected in SQL, not by filtering findCandidates' general scan: `limit` is a
 * SQL LIMIT there, applied before eligibility, so a bounded retry of "the
 * first 50" would mostly hit auctions that aren't locked and do nothing.
 * Ordered by the oldest last attempt first (never-attempted before that), so
 * repeated bounded runs rotate through the locked set instead of retrying the
 * same rows whose retry just failed again.
 *
 * Mirrors classifyLlmStatus's 'error' bucket: a stale counter on an auction
 * that already has a successful extraction (llm_analyzed_at) is not locked.
 */
export async function findLockedCandidates(opts: ReprocessOptions, countries: readonly string[]): Promise<Candidate[]> {
  if (countries.length === 0) return []
  const db = getPool()
  if (!db) return []
  const params: unknown[] = [MAX_LLM_FAILURES, countries]
  const conditions = [
    's.llm_failures >= $1',
    'a.country = ANY($2)',
    `EXISTS (SELECT 1 FROM artifact_captures rc
             WHERE rc.kind = 'auction' AND rc.platform = s.platform AND rc.external_id = s.external_id)`,
    `NOT EXISTS (SELECT 1 FROM auction_details d
                 WHERE d.platform = s.platform AND d.external_id = s.external_id
                   AND d.is_latest AND NOT d.is_trial AND d.llm_analyzed_at IS NOT NULL)`,
  ]
  if (opts.platform) conditions.push(`s.platform = $${params.push(opts.platform)}`)
  if (opts.externalId) conditions.push(`s.external_id = $${params.push(opts.externalId)}`)
  if (opts.caseNumber) conditions.push(`a.case_number = $${params.push(opts.caseNumber)}`)
  // Same rule as findCandidates: hidden (cancelled/sold) listings aren't worth
  // LLM budget, unless one auction was addressed explicitly.
  if (!opts.externalId && !opts.caseNumber) conditions.push('a.cancelled = false')
  const limitClause = opts.limit ? ` LIMIT $${params.push(opts.limit)}` : ''
  const { rows } = await db.query<{ platform: string; external_id: string; country: string }>(
    `SELECT s.platform, s.external_id, a.country
     FROM auction_fetch_state s
     JOIN auctions a ON a.platform = s.platform AND a.external_id = s.external_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY s.llm_last_attempted_at ASC NULLS FIRST, s.platform, s.external_id${limitClause}`,
    params,
  )
  return rows.map((r) => ({ platform: r.platform, externalId: r.external_id, country: r.country }))
}
