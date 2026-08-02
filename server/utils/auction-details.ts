// Typed, versioned extraction state per auction (`auction_details`). Every write
// appends a new version; rows are never updated, so the version sequence is the
// history. Replaces extraction_cache + auction_snapshot eventually — until then
// the tasks dual-write and nothing reads this table (see WP-2/WP-3 of
// docs/plans/2026-08-01-auction-identity-schema-redesign.md).
//
// `version` is its own counter, independent of artifact_versions.version: a new
// extraction version arises both from new documents and from re-running the LLM
// over the same documents (reprocess.ts). `artifact_version_id` records which
// manifest was evaluated. No-op without a configured pool, same graceful-degrade
// as extraction-cache.ts/auction-snapshot.ts.

import type { Auction, AuctionExtraction } from '~/types/auction'
import { extractTranslatableExtractionTexts } from '~/lib/extraction-translation'
import { getPool } from './db'
import { cacheKey } from './verkehrswert-cache'
import { normalizeDescriptionText } from './description-normalization'
import { withDerivedExtractionFields } from './extract/merge-llm-result'

export interface AuctionDetailsRow {
  id: number
  platform: string
  external_id: string
  version: number
  artifact_version_id: number | null
  created_at: string
  extracted_at: string
  address: string | null
  description: string | null
  property_type: string | null
  land_area_sqm: number | null
  living_area_sqm: number | null
  rooms: number | null
  bedrooms: number | null
  bathrooms: number | null
  floor: string | null
  bathroom_has_tub: boolean | null
  bathroom_has_shower: boolean | null
  heating: string | null
  units: number | null
  year_built: number | null
  last_renovation_year: number | null
  market_value: number | null
  currency: string | null
  market_value_eur: number | null
  condition: unknown
  features: string[] | null
  insights: unknown
  planning_notes: unknown
  renovation_notes: string | null
  starting_bid: number | null
  current_bid: number | null
  source_security_deposit: number | null
  security_deposit: number | null
  bidding_notes: string | null
  photo_count: number
  thumbnail_url: string | null
  lat: number | null
  lng: number | null
  extraction_source: string | null
  extraction_confidence: string | null
  llm_analyzed_at: string | null
  document_summary: string | null
  extraction_texts: unknown
}

/**
 * Columns that carry extracted content, with their Postgres types. These — and
 * only these — decide whether a write is a real change: `extracted_at` and
 * `llm_analyzed_at` move on every run and are bookkeeping, not extracted values,
 * so including them would mint a version per enrich cycle and defeat the point.
 * `artifact_version_id` IS compared: evaluating a different document manifest is
 * a genuine provenance change worth its own version.
 */
const VALUE_COLUMNS = [
  ['artifact_version_id', 'bigint'],
  ['address', 'text'],
  ['description', 'text'],
  ['property_type', 'text'],
  ['land_area_sqm', 'numeric'],
  ['living_area_sqm', 'numeric'],
  ['rooms', 'numeric'],
  ['bedrooms', 'numeric'],
  ['bathrooms', 'numeric'],
  ['floor', 'text'],
  ['bathroom_has_tub', 'boolean'],
  ['bathroom_has_shower', 'boolean'],
  ['heating', 'text'],
  ['units', 'integer'],
  ['year_built', 'integer'],
  ['last_renovation_year', 'integer'],
  ['market_value', 'numeric'],
  ['currency', 'text'],
  ['market_value_eur', 'numeric'],
  ['condition', 'jsonb'],
  ['features', 'text[]'],
  ['insights', 'jsonb'],
  ['planning_notes', 'jsonb'],
  ['renovation_notes', 'text'],
  ['starting_bid', 'numeric'],
  ['current_bid', 'numeric'],
  ['source_security_deposit', 'numeric'],
  ['security_deposit', 'numeric'],
  ['bidding_notes', 'text'],
  ['photo_count', 'integer'],
  ['thumbnail_url', 'text'],
  ['lat', 'numeric'],
  ['lng', 'numeric'],
  ['extraction_source', 'text'],
  ['extraction_confidence', 'text'],
  ['document_summary', 'text'],
  ['extraction_texts', 'jsonb'],
] as const satisfies ReadonlyArray<readonly [string, string]>

type ValueColumn = (typeof VALUE_COLUMNS)[number][0]

function json(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value)
}

/**
 * Projects an auction plus its extraction onto the `auction_details` value
 * columns. Mirrors current-auctions.ts's auctionToCurrentRow, extended with the
 * fields that only ever lived in the extraction_cache JSONB before.
 */
export function auctionDetailsValues(auction: Auction, extraction: AuctionExtraction | null): Record<ValueColumn, unknown> {
  const e = extraction ? withDerivedExtractionFields(extraction) : null
  const texts = e ? extractTranslatableExtractionTexts(e) : null
  return {
    artifact_version_id: null,
    address: auction.address,
    description: normalizeDescriptionText(auction.description),
    property_type: e?.propertyType ?? null,
    land_area_sqm: e?.landAreaSqm ?? null,
    living_area_sqm: e?.livingAreaSqm ?? null,
    rooms: e?.rooms ?? null,
    bedrooms: e?.bedrooms ?? null,
    bathrooms: e?.bathrooms ?? null,
    floor: e?.floor ?? null,
    bathroom_has_tub: e?.bathroomHasTub ?? null,
    bathroom_has_shower: e?.bathroomHasShower ?? null,
    heating: e?.heating ?? null,
    units: e?.units ?? null,
    year_built: e?.yearBuilt ?? null,
    last_renovation_year: e?.lastRenovationYear ?? null,
    market_value: auction.marketValue ?? null,
    currency: auction.currency ?? null,
    market_value_eur: auction.marketValueEur,
    condition: json(e?.condition),
    features: e?.features ?? null,
    insights: json(e?.insights),
    planning_notes: json(e?.planningNotes),
    renovation_notes: e?.renovationNotes ?? null,
    starting_bid: auction.startingBid ?? null,
    current_bid: auction.currentBid ?? null,
    source_security_deposit: auction.sourceSecurityDeposit ?? null,
    security_deposit: e?.securityDeposit ?? null,
    bidding_notes: e?.biddingNotes ?? null,
    photo_count: auction.photoCount,
    thumbnail_url: auction.thumbnailUrl,
    lat: auction.lat ?? null,
    lng: auction.lng ?? null,
    extraction_source: e?.source ?? null,
    extraction_confidence: e?.confidence ?? null,
    document_summary: e?.documentSummary ?? null,
    extraction_texts: json(texts),
  }
}

// Latest version per identity only — this is a history table, so the
// load-the-whole-table pattern of extraction-cache.ts would pull every past
// version into memory. Populated on read, refreshed on write.
const latestCache = new Map<string, AuctionDetailsRow | null>()

export function invalidateAuctionDetailsCache(): void {
  latestCache.clear()
}

export async function readLatestAuctionDetails(
  platform: string,
  externalId: string,
): Promise<AuctionDetailsRow | null> {
  const key = cacheKey(platform, externalId)
  const cached = latestCache.get(key)
  if (cached !== undefined) return cached
  const db = getPool()
  if (!db) return null
  const { rows } = await db.query<AuctionDetailsRow>(
    `SELECT * FROM auction_details
     WHERE platform = $1 AND external_id = $2
     ORDER BY version DESC LIMIT 1`,
    [platform, externalId],
  )
  const row = rows[0] ?? null
  latestCache.set(key, row)
  return row
}

export async function readAuctionDetailsAtVersion(
  platform: string,
  externalId: string,
  version: number,
): Promise<AuctionDetailsRow | null> {
  const db = getPool()
  if (!db) return null
  const { rows } = await db.query<AuctionDetailsRow>(
    `SELECT * FROM auction_details WHERE platform = $1 AND external_id = $2 AND version = $3`,
    [platform, externalId, version],
  )
  return rows[0] ?? null
}

export interface WriteAuctionDetailsResult {
  version: number
  changed: boolean
}

/**
 * Appends a new extraction version for `auction`, unless the extracted values
 * are identical to the current latest version — a re-run that produced the same
 * facts must not grow the history.
 *
 * runEnrich, runReprocess and runLlmBatchPoll can write for the same identity
 * concurrently, so the MAX(version)+1 read and the INSERT are serialized under
 * an advisory lock held for the transaction. Without it two callers can compute
 * the same next version and collide on the UNIQUE constraint; the constraint
 * catches the collision but is not a substitute for serializing.
 *
 * `artifact_version_id` is resolved from the manifest the extraction actually
 * parsed (`documentSetVersion`), so it stays NULL for a listing-only extraction.
 */
export async function writeAuctionDetails(
  auction: Auction,
  extraction: AuctionExtraction | null,
): Promise<WriteAuctionDetailsResult | null> {
  const db = getPool()
  if (!db) return null
  const { platform, externalId } = auction
  const values = auctionDetailsValues(auction, extraction)
  values.artifact_version_id = await resolveArtifactVersionId(platform, externalId, extraction)
  const extractedAt = extraction?.at ?? new Date().toISOString()
  const llmAnalyzedAt = extraction?.llmAnalyzedAt ?? null

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`auction_details:${platform}:${externalId}`])

    const unchanged = await client.query<{ version: number }>(
      `SELECT version FROM auction_details
       WHERE platform = $1 AND external_id = $2
         AND version = (SELECT max(version) FROM auction_details WHERE platform = $1 AND external_id = $2)
         AND (${VALUE_COLUMNS.map(([name]) => name).join(', ')})
             IS NOT DISTINCT FROM
             (${VALUE_COLUMNS.map(([, type], i) => `$${i + 3}::${type}`).join(', ')})`,
      [platform, externalId, ...VALUE_COLUMNS.map(([name]) => values[name])],
    )
    const unchangedVersion = unchanged.rows[0]?.version
    if (unchangedVersion !== undefined) {
      await client.query('COMMIT')
      return { version: unchangedVersion, changed: false }
    }

    const columns = ['platform', 'external_id', 'extracted_at', 'llm_analyzed_at', ...VALUE_COLUMNS.map(([name]) => name)]
    const params = [platform, externalId, extractedAt, llmAnalyzedAt, ...VALUE_COLUMNS.map(([name]) => values[name])]
    const placeholders = [
      '$1',
      '$2',
      '$3',
      '$4',
      ...VALUE_COLUMNS.map(([, type], i) => `$${i + 5}::${type}`),
    ]
    const inserted = await client.query<AuctionDetailsRow>(
      `INSERT INTO auction_details (${columns.join(', ')}, version)
       VALUES (${placeholders.join(', ')},
         COALESCE((SELECT max(version) + 1 FROM auction_details WHERE platform = $1 AND external_id = $2), 1))
       RETURNING *`,
      params,
    )
    await client.query('COMMIT')
    const row = inserted.rows[0]
    if (!row) return null
    latestCache.set(cacheKey(platform, externalId), row)
    return { version: row.version, changed: true }
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // The original error is the useful one; rollback failures only add noise.
    }
    throw err
  } finally {
    client.release()
  }
}

async function resolveArtifactVersionId(
  platform: string,
  externalId: string,
  extraction: AuctionExtraction | null,
): Promise<number | null> {
  const version = extraction?.documentSetVersion
  if (version == null) return null
  const db = getPool()
  if (!db) return null
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM artifact_versions WHERE platform = $1 AND external_id = $2 AND version = $3',
    [platform, externalId, version],
  )
  return rows[0] ? Number(rows[0].id) : null
}
