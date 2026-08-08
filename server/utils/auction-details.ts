// Typed, versioned detail/extraction state per auction. Every changed write
// appends a version; artifact_version_id records the evaluated manifest.
//
// `version` is its own counter, independent of artifact_versions.version: a new
// extraction version arises both from new documents and from re-running the LLM
// over the same documents (reprocess.ts). `artifact_version_id` records which
// manifest was evaluated. No-op without a configured pool.

import { sql } from 'drizzle-orm'
import type { Auction, AuctionExtraction, CuratedPhoto, PhotoCategory } from '~/types/auction'
import { extractTranslatableExtractionTexts } from '~/lib/extraction-translation'
import { normalizePhoto } from '~/lib/photo'
import { getDb } from './db'
import { cacheKey } from './verkehrswert-cache'
import { normalizeDescriptionText } from './description-normalization'
import { withDerivedExtractionFields } from './extract/merge-llm-result'
import { readAuctionRecord } from './auction-record'
import { upsertCurrentAuctions } from './current-auctions'

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
  extraction_source: string | null
  extraction_confidence: string | null
  llm_analyzed_at: string | null
  document_summary: string | null
  extraction_texts: unknown
  source_living_area_sqm: number | null
  source_land_area_sqm: number | null
  source_rooms: number | null
  market_value_text: string | null
  is_latest: boolean
  is_trial: boolean
  llm_provider: string | null
  llm_model: string | null
  llm_profile_id: string | null
  run_trigger: string | null
  llm_duration_ms: number | null
}

interface AuctionPhotoRow {
  ordinal: number
  file: string
  category: PhotoCategory
  caption: string | null
  is_property_photo: boolean
}

// These rows come back from raw sql`` fragments (37+ dynamic value columns,
// see writeAuctionDetails), not the typed query builder, so they need the
// Record<string, unknown> constraint db.execute<T>() imposes. Widening happens
// here instead of on the row interfaces themselves — an index signature on
// those would let a misspelled property access type-check as `unknown` for
// every consumer.
type Raw<T> = T & Record<string, unknown>

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

/** Postgres array-literal syntax for a text[] parameter. Needed because
 *  Drizzle's `sql` template expands a bound JS array into a parenthesized
 *  parameter list (`($1, $2)`, meant for `IN (...)` clauses) rather than a
 *  single array value — casting that row-constructor with `::text[]` is not
 *  valid SQL. Serializing to this literal keeps the value parameterized
 *  (still a single bound string) while giving Postgres real array syntax to
 *  parse on the cast. */
function pgTextArrayLiteral(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`
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
  const db = getDb()
  if (!db) return []
  const { rows } = await db.execute<Raw<AuctionPhotoRow>>(sql`
    SELECT ordinal, file, category, caption, is_property_photo
    FROM auction_photos WHERE auction_details_id = ${auctionDetailsId} ORDER BY ordinal
  `)
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
  const db = getDb()
  if (!db) return null
  const { rows } = await db.execute<Raw<AuctionDetailsRow>>(sql`
    SELECT * FROM auction_details
    WHERE platform = ${platform} AND external_id = ${externalId} AND is_latest = true
  `)
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
  const db = getDb()
  if (!db) return null
  const { rows } = await db.execute<Raw<AuctionDetailsRow>>(sql`
    SELECT * FROM auction_details WHERE platform = ${platform} AND external_id = ${externalId} AND version = ${version}
  `)
  return rows[0] ?? null
}

/**
 * Admin promote (docs/plans/2026-08-08-admin-auktions-technikseite.md, WP-5):
 * flips `version` to `is_latest`/not-`is_trial` and demotes whatever was
 * live before, in one transaction under the same advisory lock
 * writeAuctionDetails uses — a concurrent cron write for this identity is
 * serialized against this, not racing it. Refreshes the latest-cache and the
 * search projection afterward so both immediately reflect the promoted
 * version instead of only on the next write/rebuild.
 */
export async function promoteAuctionDetailsVersion(
  platform: string,
  externalId: string,
  version: number,
): Promise<'promoted' | 'not_found'> {
  const db = getDb()
  if (!db) return 'not_found'
  const promoted = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`auction_details:${platform}:${externalId}`}))`)
    const target = await tx.execute<{ id: number }>(sql`
      SELECT id FROM auction_details WHERE platform = ${platform} AND external_id = ${externalId} AND version = ${version}
    `)
    if (!target.rows[0]) return false
    await tx.execute(sql`
      UPDATE auction_details SET is_latest = false
      WHERE platform = ${platform} AND external_id = ${externalId} AND is_latest = true AND version <> ${version}
    `)
    await tx.execute(sql`
      UPDATE auction_details SET is_latest = true, is_trial = false
      WHERE platform = ${platform} AND external_id = ${externalId} AND version = ${version}
    `)
    return true
  })
  if (!promoted) return 'not_found'

  invalidateAuctionDetailsCache()
  // upsertCurrentAuctions only touches identity/scheduling columns (title,
  // dates, cancelled, coordinates) — none of which a promote changes — but
  // the plan calls for it anyway so this stays the one place that bumps
  // auctions.updated_at and re-checks the geocode-drift trigger after any
  // detail-level write, promote included.
  const record = await readAuctionRecord(platform, externalId)
  if (record) await upsertCurrentAuctions([record.auction], new Date().toISOString())
  return 'promoted'
}

/**
 * Admin delete (WP-5): refused for the live version — promote another
 * version first, so the partial-unique "exactly one is_latest row per
 * identity" invariant (see the table comment above) is never left with zero.
 * The WHERE clause makes that check-and-delete atomic instead of racing a
 * concurrent promote of the same row; `is_latest` is re-read only to tell
 * "already gone" apart from "still live" for a clearer error. Cascades
 * (auction_photos, auction_translations) are declared on the FKs already.
 */
export async function deleteAuctionDetailsVersion(
  platform: string,
  externalId: string,
  version: number,
): Promise<'deleted' | 'not_found' | 'is_latest'> {
  const db = getDb()
  if (!db) return 'not_found'
  const { rows } = await db.execute<{ version: number }>(sql`
    DELETE FROM auction_details
    WHERE platform = ${platform} AND external_id = ${externalId} AND version = ${version} AND is_latest = false
    RETURNING version
  `)
  if (rows[0]) return 'deleted'
  const { rows: existing } = await db.execute<{ version: number }>(sql`
    SELECT version FROM auction_details WHERE platform = ${platform} AND external_id = ${externalId} AND version = ${version}
  `)
  return existing[0] ? 'is_latest' : 'not_found'
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
  /**
   * Admin-triggered single-model comparison run (WP-0): the new row is
   * inserted with is_latest = false and never demotes the current live row,
   * and the unchanged-check (which only ever compares against the live row)
   * is skipped — an experiment reproducing the live facts is itself the
   * result, not a no-op.
   */
  trial?: boolean
  /** Provenance (WP-1) — who/what produced this version. Left null by
   *  callers that don't track it yet (enrich.ts, geocode.ts, llm-batch-poll.ts). */
  llmProvider?: string | null
  llmModel?: string | null
  llmProfileId?: string | null
  runTrigger?: 'cron' | 'manual' | null
  llmDurationMs?: number | null
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
 *
 * See WriteAuctionDetailsOptions.trial for the admin comparison-run path,
 * which never touches the live (is_latest) row.
 */
export async function writeAuctionDetails(
  auction: Auction,
  extraction: AuctionExtraction | null,
  options: WriteAuctionDetailsOptions = {},
): Promise<WriteAuctionDetailsResult | null> {
  const db = getDb()
  if (!db) return null
  const { platform, externalId } = auction
  const values = auctionDetailsValues(auction, extraction)
  const photos = normalizedPhotos(extraction)
  values.artifact_version_id = options.artifactVersionId ?? null
  const extractedAt = extraction?.at ?? new Date().toISOString()
  const llmAnalyzedAt = extraction?.llmAnalyzedAt ?? null
  const valueColumnNames = VALUE_COLUMNS.map(([name]) => name)
  // Per-column casts (matching each column's own PG type, VALUE_COLUMNS'
  // whole reason to exist) rather than a single ::jsonb/::text blanket cast:
  // a bare NULL parameter inside a multi-column ROW constructor otherwise
  // leaves Postgres unable to infer its type.
  const castValueTuple = () => sql.join(
    VALUE_COLUMNS.map(([name, type]) => {
      const value = values[name]
      const bound = type === 'text[]' && Array.isArray(value) ? pgTextArrayLiteral(value) : value
      return sql`${bound}::${sql.raw(type)}`
    }),
    sql`, `,
  )

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`auction_details:${platform}:${externalId}`}))`)

    // The live row, not the max version — once a trial version exists it can
    // outrank the live row in version without ever being it (see below).
    const previous = await tx.execute<{ id: number }>(sql`
      SELECT id FROM auction_details
      WHERE platform = ${platform} AND external_id = ${externalId} AND is_latest = true
    `)
    const previousRow = previous.rows[0] ?? null

    // A trial run (WP-0) skips the unchanged-check — reproducing the live
    // facts with a different model IS the result, not a no-op — and must
    // never demote the live row, or the experiment would go public.
    if (!options.trial) {
      const previousPhotos = previousRow
        ? await tx.execute<Raw<AuctionPhotoRow>>(sql`
            SELECT ordinal, file, category, caption, is_property_photo
            FROM auction_photos WHERE auction_details_id = ${previousRow.id} ORDER BY ordinal
          `)
        : { rows: [] as AuctionPhotoRow[] }
      const photosUnchanged = previousRow != null && photoRowsEqual(previousPhotos.rows, photos)

      const unchanged = photosUnchanged ? await tx.execute<{ version: number }>(sql`
        SELECT version FROM auction_details
        WHERE id = ${previousRow!.id}
          AND (${sql.raw(valueColumnNames.join(', '))})
              IS NOT DISTINCT FROM
              (${castValueTuple()})
      `) : { rows: [] as Array<{ version: number }> }
      const unchangedVersion = unchanged.rows[0]?.version
      if (unchangedVersion !== undefined) {
        return { version: unchangedVersion, changed: false as const, row: null as AuctionDetailsRow | null }
      }

      // is_latest has a partial UNIQUE index (one true row per identity) —
      // the new row below is inserted with is_latest = true, so the previous
      // latest must be demoted first or the insert violates that constraint.
      if (previousRow) {
        await tx.execute(sql`UPDATE auction_details SET is_latest = false WHERE id = ${previousRow.id}`)
      }
    }

    const columnNames = [
      'platform', 'external_id', 'extracted_at', 'llm_analyzed_at', 'is_latest', 'is_trial',
      'llm_provider', 'llm_model', 'llm_profile_id', 'run_trigger', 'llm_duration_ms',
      ...valueColumnNames,
    ]
    const insertValues = sql.join(
      [
        sql`${platform}`, sql`${externalId}`, sql`${extractedAt}`, sql`${llmAnalyzedAt}`,
        sql`${!options.trial}`, sql`${options.trial ?? false}`,
        sql`${options.llmProvider ?? null}`, sql`${options.llmModel ?? null}`, sql`${options.llmProfileId ?? null}`,
        sql`${options.runTrigger ?? null}`, sql`${options.llmDurationMs ?? null}`,
        castValueTuple(),
      ],
      sql`, `,
    )
    const inserted = await tx.execute<Raw<AuctionDetailsRow>>(sql`
      INSERT INTO auction_details (${sql.raw(columnNames.join(', '))}, version)
      VALUES (${insertValues},
        COALESCE((SELECT max(version) + 1 FROM auction_details WHERE platform = ${platform} AND external_id = ${externalId}), 1))
      RETURNING *
    `)
    const row = inserted.rows[0]
    if (!row) throw new Error(`auction_details insert returned no row for ${platform}/${externalId}`)

    if (photos.length > 0) {
      const photoTuples = sql.join(
        photos.map((photo, ordinal) => sql`(${row.id}, ${ordinal}, ${photo.file}, ${photo.category}, ${photo.caption}, ${photo.isPropertyPhoto})`),
        sql`, `,
      )
      await tx.execute(sql`
        INSERT INTO auction_photos
          (auction_details_id, ordinal, file, category, caption, is_property_photo)
        VALUES ${photoTuples}
      `)
    }

    return { version: row.version, changed: true as const, row }
  })

  // A trial row is never the live version — caching it here would make
  // readLatestAuctionDetails serve the experiment instead of the live row.
  if (result.changed && !options.trial) latestCache.set(cacheKey(platform, externalId), result.row!)
  return { version: result.version, changed: result.changed }
}
