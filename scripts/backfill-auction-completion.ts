// One-off additive backfill for WP-8/WP-9. Dry-run by default; pass --apply
// after schema.sql and backfill-auction-details.ts have completed.

import { Pool } from 'pg'
import type { Auction, AuctionExtraction } from '../types/auction'
import { normalizePhoto } from '../lib/photo'
import { jsonbStringify } from '../server/utils/jsonb'

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
  auction: Auction | null
  extraction: AuctionExtraction | null
  auction_details_id: string | number | null
}

async function sourceRows(): Promise<SourceRow[]> {
  const { rows } = await pool.query<SourceRow>(`
    WITH identities AS (
      SELECT platform, external_id FROM auctions
    ), latest_details AS (
      SELECT DISTINCT ON (platform, external_id) id, platform, external_id
      FROM auction_details
      ORDER BY platform, external_id, version DESC
    )
    SELECT i.platform, i.external_id, snap.auction, ec.extraction,
           ld.id AS auction_details_id
    FROM identities i
    LEFT JOIN auction_snapshot snap
      ON snap.platform = i.platform AND snap.external_id = i.external_id
    LEFT JOIN extraction_cache ec
      ON ec.platform = i.platform AND ec.external_id = i.external_id
    LEFT JOIN latest_details ld
      ON ld.platform = i.platform AND ld.external_id = i.external_id
    ORDER BY i.platform, i.external_id
  `)
  return rows
}

async function main() {
  const rows = await sourceRows()
  let fetchStates = 0
  let photoRows = 0

  for (const row of rows) {
    const auction = row.auction
    const extraction = row.extraction
    if (auction || extraction) {
      fetchStates++
      if (apply) {
        await pool.query(
          `INSERT INTO auction_fetch_state (
             platform, external_id, pdf_url, pdf_url_upstream, detail_url,
             detail_url_upstream, attachments, photo_urls, source_updated_iso,
             detail_fetched_at, llm_batch_job, llm_failures, photos_checked_at,
             photo_failures, photo_pipeline_version
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15
           )
           ON CONFLICT (platform, external_id) DO UPDATE SET
             pdf_url = COALESCE(auction_fetch_state.pdf_url, EXCLUDED.pdf_url),
             pdf_url_upstream = COALESCE(auction_fetch_state.pdf_url_upstream, EXCLUDED.pdf_url_upstream),
             detail_url = COALESCE(auction_fetch_state.detail_url, EXCLUDED.detail_url),
             detail_url_upstream = COALESCE(auction_fetch_state.detail_url_upstream, EXCLUDED.detail_url_upstream),
             attachments = CASE
               WHEN jsonb_array_length(auction_fetch_state.attachments) = 0
                 THEN EXCLUDED.attachments
               ELSE auction_fetch_state.attachments
             END,
             photo_urls = COALESCE(auction_fetch_state.photo_urls, EXCLUDED.photo_urls),
             source_updated_iso = COALESCE(
               GREATEST(auction_fetch_state.source_updated_iso, EXCLUDED.source_updated_iso),
               auction_fetch_state.source_updated_iso,
               EXCLUDED.source_updated_iso
             ),
             detail_fetched_at = COALESCE(
               GREATEST(auction_fetch_state.detail_fetched_at, EXCLUDED.detail_fetched_at),
               auction_fetch_state.detail_fetched_at,
               EXCLUDED.detail_fetched_at
             ),
             llm_batch_job = COALESCE(auction_fetch_state.llm_batch_job, EXCLUDED.llm_batch_job),
             llm_failures = GREATEST(auction_fetch_state.llm_failures, EXCLUDED.llm_failures),
             photos_checked_at = COALESCE(
               GREATEST(auction_fetch_state.photos_checked_at, EXCLUDED.photos_checked_at),
               auction_fetch_state.photos_checked_at,
               EXCLUDED.photos_checked_at
             ),
             photo_failures = GREATEST(auction_fetch_state.photo_failures, EXCLUDED.photo_failures),
             photo_pipeline_version = GREATEST(
               auction_fetch_state.photo_pipeline_version,
               EXCLUDED.photo_pipeline_version
             ),
             updated_at = now()`,
          [
            row.platform,
            row.external_id,
            auction?.pdfUrl ?? null,
            auction?.pdfUrlUpstream ?? null,
            auction?.detailUrl ?? null,
            auction?.detailUrlUpstream ?? null,
            jsonbStringify(auction?.attachments ?? []),
            auction?.photoUrls ?? null,
            auction?.sourceUpdatedIso ?? null,
            auction?.detailFetchedAt ?? null,
            extraction?.llmBatchJob ?? null,
            extraction?.llmFailures ?? 0,
            extraction?.photosCheckedAt ?? null,
            extraction?.photoFailures ?? 0,
            extraction?.photoPipelineVersion ?? null,
          ],
        )
      }
    }

    if (row.auction_details_id == null || !extraction?.photos?.length) continue
    const photos = extraction.photos.map(normalizePhoto)
    photoRows += photos.length
    if (!apply) continue
    for (const [ordinal, photo] of photos.entries()) {
      await pool.query(
        `INSERT INTO auction_photos
           (auction_details_id, ordinal, file, category, caption, is_property_photo)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (auction_details_id, ordinal) DO NOTHING`,
        [row.auction_details_id, ordinal, photo.file, photo.category, photo.caption, photo.isPropertyPhoto],
      )
    }
  }

  console.log(`[backfill] ${apply ? 'processed' : 'would process'} ${fetchStates} fetch-state rows and ${photoRows} photo rows`)
  if (!apply) console.log('[backfill] dry run - re-run with --apply to write')
  await pool.end()
}

main().catch(async (error) => {
  console.error(error)
  await pool.end().catch(() => undefined)
  process.exit(1)
})
