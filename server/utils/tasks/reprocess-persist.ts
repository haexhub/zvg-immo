import type { Auction, AuctionExtraction } from '~/types/auction'
import type { LlmConfig, LlmUsage } from '~/server/utils/extract/llm'
import { applyAuctionExtraction } from '~/server/utils/auction-extraction'
import type { AuctionRecord } from '~/server/utils/auction-record'
import { upsertCurrentAuctions } from '~/server/utils/current-auctions'
import { writeAuctionDetails } from '~/server/utils/auction-details'
import { writeAuctionLlmPipelineState } from '~/server/utils/auction-fetch-state'
import { resolveCostUsd } from '~/server/utils/extract/llm-pricing'

/** Run-level values every persisted entry of one reprocess run shares. */
export interface ReprocessPersistContext {
  runTrigger: 'cron' | 'manual'
  /** The run's start timestamp (`updated_at` of the touched auctions). */
  at: string
}

export async function persistReprocessEntry(
  ctx: ReprocessPersistContext,
  record: AuctionRecord,
  entry: AuctionExtraction,
  artifactVersionId: number | null,
  llmFailures: number,
  archivedAuction: Auction,
  llmAttempted: boolean,
  llmConfigUsed: LlmConfig | null = null,
  llmDurationMs: number | null = null,
  llmUsage: LlmUsage | null = null,
): Promise<void> {
  // record.auction is reconstructed from auctions LEFT JOIN LATERAL
  // auction_details (see auction-record.ts) — when no auction_details row
  // exists yet (a brand-new identity, or one whose details were wiped, e.g.
  // by rebuildCountry), every crawl-owned field on it is null/0. This task
  // never crawls live, so without this fallback that blank snapshot would
  // become the permanent first version — address stays empty forever and
  // geocoding never gets a query to run (see WP-3 SE root cause). The
  // archived 'auction' capture this run already read is the actual crawl
  // output and the correct source for that first write; lat/lng stay from
  // record.auction since geocoding writes there independently and may be
  // newer than the archive.
  const base = record.detailsId == null
    ? { ...archivedAuction, lat: record.auction.lat, lng: record.auction.lng }
    : record.auction
  const updated: Auction = { ...base, extraction: entry }
  applyAuctionExtraction(updated, entry)
  await writeAuctionDetails(updated, entry, {
    artifactVersionId,
    llmProvider: llmConfigUsed ? (llmConfigUsed.provider ?? 'openai-compatible') : null,
    llmModel: llmConfigUsed?.model ?? null, llmProfileId: llmConfigUsed?.profileId ?? null,
    runTrigger: ctx.runTrigger,
    llmDurationMs,
    llmCostUsd: llmConfigUsed ? resolveCostUsd(llmConfigUsed.model, llmUsage) : null,
    llmInputTokens: llmUsage?.inputTokens ?? null, llmOutputTokens: llmUsage?.outputTokens ?? null,
  })
  await upsertCurrentAuctions([updated], ctx.at)
  await writeAuctionLlmPipelineState(record.auction.platform, record.auction.externalId, {
    llmBatchJob: null,
    llmArtifactVersionId: null,
    llmRulesHint: null,
    llmFailures,
    llmAttempted,
  })
  record.auction = updated
  record.artifactVersionId = artifactVersionId
}
