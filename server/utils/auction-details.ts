// Typed, versioned detail/extraction state per auction. Every changed write
// appends a version; artifact_version_id records the evaluated manifest.
//
// `version` is its own counter, independent of artifact_versions.version: a new
// extraction version arises both from new documents and from re-running the LLM
// over the same documents (reprocess.ts). `artifact_version_id` records which
// manifest was evaluated. No-op without a configured pool.

import type { Auction, AuctionExtraction, CuratedPhoto, PhotoCategory } from '~/types/auction'
import { extractTranslatableExtractionTexts } from '~/lib/extraction-translation'
import { normalizePhoto } from '~/lib/photo'
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
  source_living_area_sqm: number | null
  source_land_area_sqm: number | null
  source_rooms: number | null
  market_value_text: string | null
}

interface AuctionPhotoRow {
  ordinal: number
  file: string
  category: PhotoCategory
  caption: string | null
  is_property_photo: boolean
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
  ['source_living_area_sqm', 'numeric'],
  ['source_land_area_sqm', 'numeric'],
  ['source_rooms', 'numeric'],
  ['market_value_text', 'text'],
] as const satisfies ReadonlyArray<readonly [string, string]>

type ValueColumn = (typeof VALUE_COLUMNS)[number][0]

/**
 * `undefined` becomes SQL NULL, an explicit `null` becomes the jsonb `null`
 * literal. AuctionExtraction distinguishes the two — "never checked yet" vs
 * "checked, found nothing" — and the llmOnly search filter reads that
 * distinction, so collapsing both to SQL NULL would change what it hides.
 */
function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

// node-postgres returns `numeric` as a string to avoid float precision loss.
function numeric(value: number | string | null): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Projects an auction plus its extraction onto the versioned
 * `auction_details` value columns.
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
    source_living_area_sqm: auction.sourceLivingAreaSqm ?? null,
    source_land_area_sqm: auction.sourceLandAreaSqm ?? null,
    source_rooms: auction.sourceRooms ?? null,
    market_value_text: e?.marketValueText ?? auction.marketValueText,
  }
}

function normalizedPhotos(extraction: AuctionExtraction | null): CuratedPhoto[] {
  return (extraction?.photos ?? []).map(normalizePhoto)
}

function photoRowsEqual(rows: AuctionPhotoRow[], photos: CuratedPhoto[]): boolean {
  return rows.length === photos.length && rows.every((row, index) => {
    const photo = photos[index]
    return !!photo &&
      row.ordinal === index &&
      row.file === photo.file &&
      row.category === photo.category &&
      row.caption === photo.caption &&
      row.is_property_photo === photo.isPropertyPhoto
  })
}

export async function readAuctionPhotos(auctionDetailsId: number): Promise<CuratedPhoto[]> {
  const db = getPool()
  if (!db) return []
  const { rows } = await db.query<AuctionPhotoRow>(
    `SELECT ordinal, file, category, caption, is_property_photo
     FROM auction_photos WHERE auction_details_id = $1 ORDER BY ordinal`,
    [auctionDetailsId],
  )
  return rows.map((row) => ({
    file: row.file,
    category: row.category,
    caption: row.caption,
    isPropertyPhoto: row.is_property_photo,
  }))
}

// Latest version per identity only; loading the whole history would grow
// without bound. Populated on read, refreshed on write.
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
  // Only cache a hit. A miss may become a row through another app instance.
  if (row) latestCache.set(key, row)
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

export interface WriteAuctionDetailsOptions {
  /**
   * Manifest actually evaluated for this version. An explicit null preserves
   * "listing/rules only" even when a newer archived manifest already exists.
   */
  artifactVersionId?: number | null
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
 * Callers pass the manifest actually evaluated. It stays NULL for listing-only
 * or rules-only extraction.
 */
export async function writeAuctionDetails(
  auction: Auction,
  extraction: AuctionExtraction | null,
  options: WriteAuctionDetailsOptions = {},
): Promise<WriteAuctionDetailsResult | null> {
  const db = getPool()
  if (!db) return null
  const { platform, externalId } = auction
  const values = auctionDetailsValues(auction, extraction)
  const photos = normalizedPhotos(extraction)
  values.artifact_version_id = options.artifactVersionId ?? null
  const extractedAt = extraction?.at ?? new Date().toISOString()
  const llmAnalyzedAt = extraction?.llmAnalyzedAt ?? null

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`auction_details:${platform}:${externalId}`])

    const previous = await client.query<{ id: number; lat: number | null; lng: number | null }>(
      `SELECT id, lat, lng FROM auction_details
       WHERE platform = $1 AND external_id = $2
       ORDER BY version DESC LIMIT 1`,
      [platform, externalId],
    )
    const previousRow = previous.rows[0] ?? null
    const previousPhotos = previousRow
      ? await client.query<AuctionPhotoRow>(
          `SELECT ordinal, file, category, caption, is_property_photo
           FROM auction_photos WHERE auction_details_id = $1 ORDER BY ordinal`,
          [previousRow.id],
        )
      : { rows: [] as AuctionPhotoRow[] }
    const photosUnchanged = previousRow != null && photoRowsEqual(previousPhotos.rows, photos)

    const unchanged = photosUnchanged ? await client.query<{ version: number }>(
      `SELECT version FROM auction_details
       WHERE platform = $1 AND external_id = $2
         AND version = (SELECT max(version) FROM auction_details WHERE platform = $1 AND external_id = $2)
         AND (${VALUE_COLUMNS.map(([name]) => name).join(', ')})
             IS NOT DISTINCT FROM
             (${VALUE_COLUMNS.map(([, type], i) => `$${i + 3}::${type}`).join(', ')})`,
      [platform, externalId, ...VALUE_COLUMNS.map(([name]) => values[name])],
    ) : { rows: [] as Array<{ version: number }> }
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
    const row = inserted.rows[0]
    if (!row) throw new Error(`auction_details insert returned no row for ${platform}/${externalId}`)
    if (photos.length > 0) {
      const photoValues: unknown[] = []
      const photoTuples = photos.map((photo, ordinal) => {
        const offset = photoValues.length
        photoValues.push(row.id, ordinal, photo.file, photo.category, photo.caption, photo.isPropertyPhoto)
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`
      })
      await client.query(
        `INSERT INTO auction_photos
           (auction_details_id, ordinal, file, category, caption, is_property_photo)
         VALUES ${photoTuples.join(', ')}`,
        photoValues,
      )
    }
    await client.query('COMMIT')
    latestCache.set(cacheKey(platform, externalId), row)
    if (coordinatesMovedSignificantly(
      previousRow ? { lat: numeric(previousRow.lat), lng: numeric(previousRow.lng) } : null,
      { lat: numeric(row.lat), lng: numeric(row.lng) },
    )) {
      triggerLocationEnrichment(platform, externalId)
    }
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

// Geocoders return slightly different coordinates for the same address between
// runs, so an exact comparison would re-enrich constantly. 100 m is well above
// that noise and well below the distance at which the location context (nearby
// amenities, hazard zones, noise bands) would meaningfully differ.
const COORDINATE_CHANGE_THRESHOLD_METERS = 100

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000
  const toRad = (deg: number): number => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** Exported for tests. */
export function coordinatesMovedSignificantly(
  previous: { lat: number | null; lng: number | null } | null,
  next: { lat: number | null; lng: number | null },
): boolean {
  if (next.lat == null || next.lng == null) return false
  // First coordinates this auction ever had — including a brand new auction,
  // whose identity row is created before any geocoding has run.
  if (previous?.lat == null || previous?.lng == null) return true
  return distanceMeters(previous.lat, previous.lng, next.lat, next.lng) > COORDINATE_CHANGE_THRESHOLD_METERS
}

/**
 * Fire-and-forget re-enrichment of one auction's location context.
 *
 * The nightly full sweep stays the mechanism for externally-updated datasets
 * (EU flood zones, EFFIS, EEA noise, CAMS air quality) — those change without
 * anything happening on the auction side. It is not enough for "this auction's
 * coordinates just moved", though: up to 24 h of wrong context. Never awaited,
 * so the extraction path doesn't wait on external HTTP.
 */
function triggerLocationEnrichment(platform: string, externalId: string): void {
  // Absent outside the Nitro runtime (unit tests), where there is no task to run.
  if (typeof runTask !== 'function') return
  void runTask('external-enrichment', { payload: { platform, externalId } }).catch((err: unknown) => {
    console.error(`[auction-details] external enrichment trigger failed for ${platform}/${externalId}: ${(err as Error).message}`)
  })
}
