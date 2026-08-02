// One-off backfill: seeds `auction_details` version 1 for every auction that
// already has extraction_cache/auction_snapshot data, so the versioned history
// introduced by WP-2 of
// docs/plans/2026-08-01-auction-identity-schema-redesign.md has a starting
// point. Deliberately not part of schema.sql's boot migration — it is historical
// and runs once.
//
// This is an explicit best-effort starting point, not a reconstruction of
// historical provenance: everything that existed before the redesign collapses
// into a single version 1. `artifact_version_id` points at the newest manifest
// currently on record for the auction (or NULL if none exists), and
// `extracted_at` prefers AuctionExtraction.at, falling back to
// extraction_cache.updated_at.
//
// Usage:
//   NUXT_DATABASE_URL=... npx tsx scripts/backfill-auction-details.ts [--apply]
//
// Without --apply, only reports what would be written (dry run, no writes).

import { Pool } from 'pg'
import type { Auction, AuctionExtraction } from '../types/auction'
import { auctionDetailsValues } from '../server/utils/auction-details'

const apply = process.argv.includes('--apply')
const databaseUrl = process.env.NUXT_DATABASE_URL
if (!databaseUrl) {
  console.error('NUXT_DATABASE_URL is required')
  process.exit(1)
}

const pool = new Pool({ connectionString: databaseUrl })

interface SourceRow {
  platform: string
  external_id: string
  extraction: AuctionExtraction | null
  auction: Auction | null
  extraction_updated_at: string | null
  artifact_version_id: string | null
}

const VALUE_COLUMNS = [
  'artifact_version_id', 'address', 'description', 'property_type', 'land_area_sqm',
  'living_area_sqm', 'rooms', 'bedrooms', 'bathrooms', 'floor', 'bathroom_has_tub',
  'bathroom_has_shower', 'heating', 'units', 'year_built', 'last_renovation_year',
  'market_value', 'currency', 'market_value_eur', 'condition', 'features', 'insights',
  'planning_notes', 'renovation_notes', 'starting_bid', 'current_bid',
  'source_security_deposit', 'security_deposit', 'bidding_notes', 'photo_count',
  'thumbnail_url', 'lat', 'lng', 'extraction_source', 'extraction_confidence',
  'document_summary', 'extraction_texts',
  'source_living_area_sqm', 'source_land_area_sqm', 'source_rooms',
  'market_value_text',
] as const

const COLUMN_TYPES: Record<string, string> = {
  artifact_version_id: 'bigint', land_area_sqm: 'numeric', living_area_sqm: 'numeric',
  rooms: 'numeric', bedrooms: 'numeric', bathrooms: 'numeric',
  bathroom_has_tub: 'boolean', bathroom_has_shower: 'boolean', units: 'integer',
  year_built: 'integer', last_renovation_year: 'integer', market_value: 'numeric',
  market_value_eur: 'numeric', condition: 'jsonb', features: 'text[]',
  insights: 'jsonb', planning_notes: 'jsonb', starting_bid: 'numeric',
  current_bid: 'numeric', source_security_deposit: 'numeric',
  security_deposit: 'numeric', photo_count: 'integer', lat: 'numeric',
  lng: 'numeric', extraction_texts: 'jsonb',
  source_living_area_sqm: 'numeric', source_land_area_sqm: 'numeric',
  source_rooms: 'numeric',
}

async function main() {
  // Left joins in both directions: an auction can have an extraction without a
  // snapshot (reprocess ran, enrich hasn't re-snapshotted) and vice versa. Only
  // identities that already have an `auctions` row are eligible — auction_details
  // carries an FK to it, and WP-1's backfill has already minted one for every
  // identity that appears in the archive.
  const { rows } = await pool.query<SourceRow>(`
    WITH identities AS (
      SELECT platform, external_id FROM extraction_cache
      UNION
      SELECT platform, external_id FROM auction_snapshot
    )
    SELECT i.platform, i.external_id,
           ec.extraction, ec.updated_at AS extraction_updated_at,
           snap.auction,
           (SELECT av.id FROM artifact_versions av
             WHERE av.platform = i.platform AND av.external_id = i.external_id
             ORDER BY av.version DESC LIMIT 1) AS artifact_version_id
    FROM identities i
    JOIN auctions a ON a.platform = i.platform AND a.external_id = i.external_id
    LEFT JOIN extraction_cache ec ON ec.platform = i.platform AND ec.external_id = i.external_id
    LEFT JOIN auction_snapshot snap ON snap.platform = i.platform AND snap.external_id = i.external_id
    LEFT JOIN auction_details ad ON ad.platform = i.platform AND ad.external_id = i.external_id
    WHERE ad.id IS NULL
    ORDER BY i.platform, i.external_id
  `)

  console.log(`[backfill] ${rows.length} identities without any auction_details row`)

  let written = 0
  let skippedNoAuction = 0
  for (const row of rows) {
    if (!row.auction) {
      // No snapshot means no Auction-level fields (address, price, photos) —
      // a version built from the extraction alone would be a misleadingly
      // empty "version 1". Left for the next real extraction run instead.
      skippedNoAuction++
      continue
    }
    const values = auctionDetailsValues(row.auction, row.extraction)
    values.artifact_version_id = row.artifact_version_id == null ? null : Number(row.artifact_version_id)
    const extractedAt = row.extraction?.at ?? row.extraction_updated_at ?? new Date().toISOString()

    if (!apply) {
      written++
      continue
    }
    const columns = ['platform', 'external_id', 'version', 'extracted_at', 'llm_analyzed_at', ...VALUE_COLUMNS]
    const params = [
      row.platform, row.external_id, 1, extractedAt, row.extraction?.llmAnalyzedAt ?? null,
      ...VALUE_COLUMNS.map((c) => values[c]),
    ]
    const placeholders = params.map((_, i) => {
      const column = columns[i]!
      const type = COLUMN_TYPES[column]
      return type ? `$${i + 1}::${type}` : `$${i + 1}`
    })
    await pool.query(
      `INSERT INTO auction_details (${columns.join(', ')}) VALUES (${placeholders.join(', ')})
       ON CONFLICT (platform, external_id, version) DO NOTHING`,
      params,
    )
    written++
  }

  console.log(
    `[backfill] ${apply ? 'wrote' : 'would write'} ${written} version-1 rows` +
      (skippedNoAuction > 0 ? `, skipped ${skippedNoAuction} without an auction_snapshot` : ''),
  )
  if (!apply) console.log('[backfill] dry run — re-run with --apply to write')
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
