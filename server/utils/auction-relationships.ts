// Links independently stored auction records without ever merging them.
// `same_proceeding` is deliberately strict; `same_address` is a navigation
// hint only, useful for multiple units in one building or related proceedings.

import type { Pool } from 'pg'
import { getPool } from './db'

export type AuctionRelationshipKind = 'same_proceeding' | 'same_address'
export type AuctionRelationshipConfidence = 'high' | 'medium'

export interface RelatedAuction {
  platform: string
  externalId: string
  kind: AuctionRelationshipKind
  confidence: AuctionRelationshipConfidence
  country: string
  region: string
  authority: string
  caseNumber: string
  title: string | null
  address: string | null
  auctionDateIso: string | null
  auctionDateText: string | null
  marketValueEur: number | null
}

export interface RelationshipCandidate {
  platform: string
  externalId: string
  country: string
  authority: string
  caseNumber: string
  address: string | null
  auctionDateIso: string | null
}

interface AutomaticRelationship {
  left: RelationshipCandidate
  right: RelationshipCandidate
  kind: AuctionRelationshipKind
  confidence: AuctionRelationshipConfidence
  evidence: Record<string, boolean>
}

function identityKey(auction: Pick<RelationshipCandidate, 'platform' | 'externalId'>): string {
  return `${auction.platform}:${auction.externalId}`
}

function compareIdentity(a: RelationshipCandidate, b: RelationshipCandidate): number {
  if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1
  if (a.externalId === b.externalId) return 0
  return a.externalId < b.externalId ? -1 : 1
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Normalizes the common German `2 K 15/18` / `0002 K 0015/2018` variants.
 * Unknown formats deliberately remain unmatched instead of guessing.
 */
export function canonicalCaseNumber(value: string): string | null {
  const match = normalizeText(value).match(/^0*(\d+)\s*k\s*0*(\d+)\s*\/\s*0*(\d{2,4})$/)
  const courtPart = match?.[1]
  const sequencePart = match?.[2]
  const yearPart = match?.[3]
  if (!courtPart || !sequencePart || !yearPart) return null
  const courtNumber = String(Number(courtPart))
  const sequence = String(Number(sequencePart))
  const year = yearPart.slice(-2)
  if (courtNumber === '0' || sequence === '0') return null
  return `${courtNumber} k ${sequence}/${year}`
}

export function canonicalAddress(value: string | null): string | null {
  if (!value) return null
  const normalized = normalizeText(value).replace(/[^\p{L}\p{N}]/gu, '')
  // A city-only address is far too broad to make an automatic association.
  return normalized.length >= 8 && /\d/.test(normalized) ? normalized : null
}

function groupBy<T>(items: T[], keyFor: (item: T) => string | null): T[][] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyFor(item)
    if (!key) continue
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return [...groups.values()].filter((group) => group.length > 1)
}

function pairs(group: RelationshipCandidate[]): Array<[RelationshipCandidate, RelationshipCandidate]> {
  const result: Array<[RelationshipCandidate, RelationshipCandidate]> = []
  for (let left = 0; left < group.length; left++) {
    for (let right = left + 1; right < group.length; right++) {
      const a = group[left]
      const b = group[right]
      if (a && b) result.push(compareIdentity(a, b) < 0 ? [a, b] : [b, a])
    }
  }
  return result
}

/** Pure candidate matcher, exported so the edge rules stay regression-tested. */
export function buildAutomaticRelationships(candidates: RelationshipCandidate[]): AutomaticRelationship[] {
  const byPair = new Map<string, AutomaticRelationship>()
  const add = (left: RelationshipCandidate, right: RelationshipCandidate, kind: AuctionRelationshipKind, confidence: AuctionRelationshipConfidence, evidence: Record<string, boolean>) => {
    const key = `${identityKey(left)}|${identityKey(right)}`
    const existing = byPair.get(key)
    // Same proceeding is the stronger, more specific statement.
    if (!existing || kind === 'same_proceeding') byPair.set(key, { left, right, kind, confidence, evidence })
  }

  for (const group of groupBy(candidates, (auction) => {
    const caseNumber = canonicalCaseNumber(auction.caseNumber)
    if (!caseNumber || !auction.auctionDateIso) return null
    return `${auction.country}|${normalizeText(auction.authority)}|${caseNumber}|${auction.auctionDateIso}`
  })) {
    for (const [left, right] of pairs(group)) {
      add(left, right, 'same_proceeding', 'high', { sameAuthority: true, sameCaseNumber: true, sameAuctionDate: true })
    }
  }

  for (const group of groupBy(candidates, (auction) => {
    const address = canonicalAddress(auction.address)
    return address ? `${auction.country}|${address}` : null
  })) {
    for (const [left, right] of pairs(group)) {
      add(left, right, 'same_address', 'medium', { sameAddress: true })
    }
  }

  return [...byPair.values()]
}

interface RelationshipCandidateRow {
  platform: string
  external_id: string
  country: string
  authority: string
  case_number: string
  address: string | null
  auction_date_iso: Date | string | null
}

function iso(value: Date | string | null): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : value
}

function toCandidate(row: RelationshipCandidateRow): RelationshipCandidate {
  return {
    platform: row.platform,
    externalId: row.external_id,
    country: row.country,
    authority: row.authority,
    caseNumber: row.case_number,
    address: row.address,
    auctionDateIso: iso(row.auction_date_iso),
  }
}

/** Rebuilds automatic edges for the affected countries; manual edges stay untouched. */
export async function rebuildAutomaticAuctionRelationships(countries: string[]): Promise<void> {
  const db = getPool()
  const uniqueCountries = [...new Set(countries.map((country) => country.toLowerCase()).filter(Boolean))]
  if (!db || uniqueCountries.length === 0) return

  const { rows } = await db.query<RelationshipCandidateRow>(`
    SELECT a.platform, a.external_id, a.country, a.authority, a.case_number,
      d.address, a.auction_date_iso
    FROM auctions a
    LEFT JOIN LATERAL (
      SELECT address FROM auction_details
      WHERE platform = a.platform AND external_id = a.external_id AND is_latest = true
      LIMIT 1
    ) d ON true
    WHERE a.country = ANY($1::text[])
  `, [uniqueCountries])
  const relationships = buildAutomaticRelationships(rows.map(toCandidate))

  await db.query(`
    DELETE FROM auction_relationships r
    USING auctions a
    WHERE r.source = 'auto'
      AND (a.platform = r.left_platform AND a.external_id = r.left_external_id
        OR a.platform = r.right_platform AND a.external_id = r.right_external_id)
      AND a.country = ANY($1::text[])
  `, [uniqueCountries])
  await insertAutomaticRelationships(db, relationships)
}

async function insertAutomaticRelationships(db: Pool, relationships: AutomaticRelationship[]): Promise<void> {
  const CHUNK_SIZE = 500
  for (let start = 0; start < relationships.length; start += CHUNK_SIZE) {
    const chunk = relationships.slice(start, start + CHUNK_SIZE)
    const values: unknown[] = []
    const tuples = chunk.map((relationship) => {
      values.push(
        relationship.left.platform,
        relationship.left.externalId,
        relationship.right.platform,
        relationship.right.externalId,
        relationship.kind,
        relationship.confidence,
        JSON.stringify(relationship.evidence),
      )
      const end = values.length
      return `($${end - 6}, $${end - 5}, $${end - 4}, $${end - 3}, $${end - 2}, $${end - 1}, 'auto', $${end}::jsonb)`
    })
    await db.query(`
      INSERT INTO auction_relationships (
        left_platform, left_external_id, right_platform, right_external_id,
        kind, confidence, source, evidence
      ) VALUES ${tuples.join(', ')}
      ON CONFLICT (left_platform, left_external_id, right_platform, right_external_id)
      DO UPDATE SET kind = EXCLUDED.kind, confidence = EXCLUDED.confidence,
        source = EXCLUDED.source, evidence = EXCLUDED.evidence, updated_at = now()
      WHERE auction_relationships.source = 'auto'
    `, values)
  }
}

interface RelatedAuctionRow {
  platform: string
  external_id: string
  kind: AuctionRelationshipKind
  confidence: AuctionRelationshipConfidence
  country: string
  region: string
  authority: string
  case_number: string
  title: string | null
  address: string | null
  auction_date_iso: Date | string | null
  auction_date_text: string | null
  market_value_eur: string | number | null
}

function number(value: string | number | null): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Reads both directions of the canonical edge for one detail page. */
export async function readAuctionRelationships(platform: string, externalId: string): Promise<RelatedAuction[]> {
  const db = getPool()
  if (!db) return []
  const { rows } = await db.query<RelatedAuctionRow>(`
    SELECT target.platform, target.external_id, r.kind, r.confidence,
      target.country, target.region, target.authority, target.case_number,
      target.title, d.address, target.auction_date_iso, target.auction_date_text,
      d.market_value_eur
    FROM auction_relationships r
    JOIN auctions target ON (target.platform, target.external_id) =
      (CASE WHEN r.left_platform = $1 AND r.left_external_id = $2 THEN r.right_platform ELSE r.left_platform END,
       CASE WHEN r.left_platform = $1 AND r.left_external_id = $2 THEN r.right_external_id ELSE r.left_external_id END)
    LEFT JOIN LATERAL (
      SELECT address, market_value_eur FROM auction_details
      WHERE platform = target.platform AND external_id = target.external_id AND is_latest = true
      LIMIT 1
    ) d ON true
    WHERE (r.left_platform = $1 AND r.left_external_id = $2)
       OR (r.right_platform = $1 AND r.right_external_id = $2)
    ORDER BY CASE r.kind WHEN 'same_proceeding' THEN 0 ELSE 1 END,
      target.auction_date_iso NULLS LAST, target.platform, target.external_id
  `, [platform, externalId])
  return rows.map((row) => ({
    platform: row.platform,
    externalId: row.external_id,
    kind: row.kind,
    confidence: row.confidence,
    country: row.country,
    region: row.region,
    authority: row.authority,
    caseNumber: row.case_number,
    title: row.title,
    address: row.address,
    auctionDateIso: iso(row.auction_date_iso),
    auctionDateText: row.auction_date_text,
    marketValueEur: number(row.market_value_eur),
  }))
}
