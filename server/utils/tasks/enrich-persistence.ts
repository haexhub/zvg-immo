import type { Auction } from '~/types/auction'
import type { crawlAll } from '~/server/crawlers/registry'
import { applyAuctionExtraction } from '~/server/utils/auction-extraction'
import { readAuctionRecordMap } from '~/server/utils/auction-record'
import { mergeStoredAuction } from '~/server/utils/auction-merge'
import { upsertCurrentAuctions } from '~/server/utils/current-auctions'
import { normalizeAuctionDescriptions } from '~/server/utils/description-normalization'
import { recordObservations } from '~/server/utils/history'
import { writeAuctionCrawlFetchState } from '~/server/utils/auction-fetch-state'
import { writeAuctionDetails } from '~/server/utils/auction-details'
import { rebuildAutomaticAuctionRelationships } from '~/server/utils/auction-relationships'
import { cacheKey, readVerkehrswertCache } from '~/server/utils/verkehrswert-cache'
import { throwIfTaskAborted } from '~/server/utils/exclusive-task'

export async function finalizeEnrichPersistence({
  result,
  country,
  persistedDetails,
  capturedAt,
  at,
  pushRunError,
  signal,
}: {
  result: Awaited<ReturnType<typeof crawlAll>>
  /** The run's country scope; the stored records are re-read for it here. */
  country?: string
  persistedDetails: Map<string, { marketValueEur: number | null; marketValueText: string | null }>
  capturedAt: string
  at: string
  pushRunError: (category: string, message: string, identity?: { platform?: string; externalId?: string }) => void
  signal?: AbortSignal
}) {
  // Re-read shortly before the final projection so values produced while
  // this crawl was running are included.
  const vwCache = await readVerkehrswertCache()
  // Same for the stored records: the run-start snapshot predates hours of
  // concurrent reprocess/llm-batch-poll writes, and writing its extraction
  // back would roll a newer LLM result back to the old rules values.
  // ponytail: one re-read per finalize, not per auction — a reprocess write
  // landing during the loop below can still be overwritten for that identity;
  // closing that needs an expected-llm_analyzed_at check in writeAuctionDetails.
  const records = await readAuctionRecordMap(country)
  for (const a of result.auctions) {
    throwIfTaskAborted(signal)
    if (a.marketValueEur != null) continue
    const hit = vwCache[cacheKey(a.platform, a.externalId)]
    if (!hit) continue
    a.marketValueEur = hit.marketValueEur
    a.marketValueText = hit.marketValueText
  }
  // Preserve structured details for list-only rows and overlay the latest
  // extraction before writing the current SQL projection. The re-read record
  // wins over the worker's in-memory entry: it already contains that entry's
  // write plus anything stored after it.
  for (const auction of result.auctions) {
    const record = records.get(cacheKey(auction.platform, auction.externalId))
    if (auction.detailFetchedAt == null && record) mergeStoredAuction(auction, record.auction)
    applyAuctionExtraction(auction, record?.auction.extraction ?? auction.extraction)
  }
  normalizeAuctionDescriptions(result.auctions)
  await writeAuctionCrawlFetchState(result.auctions)
  // Persist every current aggregate. Unchanged values do not create a new
  // auction_details version.
  for (const a of result.auctions) {
    throwIfTaskAborted(signal)
    const persisted = persistedDetails.get(cacheKey(a.platform, a.externalId))
    if (
      persisted &&
      persisted.marketValueEur === a.marketValueEur &&
      persisted.marketValueText === a.marketValueText
    ) continue
    try {
      const record = records.get(cacheKey(a.platform, a.externalId))
      await writeAuctionDetails(a, a.extraction ?? null, {
        artifactVersionId: record?.artifactVersionId ?? null,
      })
    } catch (err) {
      pushRunError('auction_details', `auction_details ${a.platform}:${a.externalId}: ${(err as Error).message}`, a)
    }
  }
  // Record the final enriched payload, not the earlier list-only regional
  // shape. This keeps each analytical observation complete with detail,
  // document, photo and extraction fields available at this run.
  await recordObservations(result, capturedAt)
  // Structured Postgres mirror for fast SQL filter queries (Daten-API, admin
  // tooling) — additive, no-op without NUXT_DATABASE_URL. See
  // server/utils/current-auctions.ts.
  await upsertCurrentAuctions(result.auctions, at)
  // Associations are navigation metadata, never a merge. Rebuild only the
  // countries touched by this complete crawl result, after its current details
  // are visible to the relationship query.
  await rebuildAutomaticAuctionRelationships(result.auctions.map((auction) => auction.country))
  for (const failure of result.errors) {
    pushRunError('crawl', `${failure.country}/${failure.region}: ${failure.message}`)
  }
}
