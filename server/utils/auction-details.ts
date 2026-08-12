// Typed, versioned detail/extraction state per auction. Every changed write
// appends a version; artifact_version_id records the evaluated manifest.
//
// `version` is its own counter, independent of artifact_versions.version: a new
// extraction version arises both from new documents and from re-running the LLM
// over the same documents (reprocess.ts). `artifact_version_id` records which
// manifest was evaluated. No-op without a configured pool.

import { sql } from 'drizzle-orm'
import type { Auction, AuctionExtraction, CuratedPhoto, PhotoCategory } from '~/types/auction'
import { getDb } from './db'
import { readAuctionRecord } from './auction-record'
import { upsertCurrentAuctions } from './current-auctions'
import {
  auctionDetailsValues, cacheLatestAuctionDetails, invalidateAuctionDetailsCache,
  normalizedPhotos, pgTextArrayLiteral, photoRowsEqual, VALUE_COLUMNS,
  type AuctionDetailsRow, type AuctionPhotoRow, type Raw,
} from './auction-details-read'
export {
  auctionDetailsValues, invalidateAuctionDetailsCache, readAuctionDetailsAtVersion,
  readLatestAuctionDetails, readAuctionPhotos,
} from './auction-details-read'

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
  llmCostUsd?: number | null
  llmInputTokens?: number | null
  llmOutputTokens?: number | null
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
      'llm_provider', 'llm_model', 'llm_profile_id', 'run_trigger', 'llm_duration_ms', 'llm_cost_usd',
      'llm_input_tokens', 'llm_output_tokens',
      ...valueColumnNames,
    ]
    const insertValues = sql.join(
      [
        sql`${platform}`, sql`${externalId}`, sql`${extractedAt}`, sql`${llmAnalyzedAt}`,
        sql`${!options.trial}`, sql`${options.trial ?? false}`,
        sql`${options.llmProvider ?? null}`, sql`${options.llmModel ?? null}`, sql`${options.llmProfileId ?? null}`,
        sql`${options.runTrigger ?? null}`, sql`${options.llmDurationMs ?? null}`, sql`${options.llmCostUsd ?? null}`,
        sql`${options.llmInputTokens ?? null}`, sql`${options.llmOutputTokens ?? null}`,
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
  if (result.changed && !options.trial) cacheLatestAuctionDetails(platform, externalId, result.row!)
  return { version: result.version, changed: result.changed }
}
