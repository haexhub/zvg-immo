// Shared single-translation retry: claims one auction/lang row and re-runs
// the LLM translation, bypassing the normal 1h failed-attempt backoff. Used
// by both the admin single-row retry endpoint (server/api/settings/auction/
// [platform]/[id]/translation-retry.post.ts) and the country-wide open/failed
// bulk retry endpoints, so the retry logic can't drift between them.
//
// claimAuctionTranslation itself has no time-based gate on a 'failed' row
// (only the read path in translation.post.ts enforces retryDue), so calling
// it directly here is enough; no separate bypass flag is needed.

import type { Pool } from 'pg'
import type { Auction } from '~/types/auction'
import { readAuctionRecord } from '~/server/utils/auction-record'
import {
  claimAuctionTranslation,
  completeAuctionTranslation,
  failAuctionTranslation,
  readContentTranslation,
  writeContentTranslation,
  type AuctionTranslationClaim,
} from '~/server/utils/content-translation'
import { isLlmProviderUnavailable, type LlmConfig } from '~/server/utils/extract/llm'
import type { TranslationResult } from '~/server/utils/extract/text-llm'
import { fingerprintConfigChain, resolveActiveLlmConfigChain } from '~/server/utils/translation-llm-chain'
import { countryContentLanguage, type ContentTargetLang } from '~/lib/content-language'
import { extractTranslatableExtractionTexts } from '~/lib/extraction-translation'
import { auctionTranslationContentHash, tryTranslate } from '~/server/api/auction/[platform]/[id]/translation.post'

async function runRetry(
  db: Pool,
  platform: string,
  externalId: string,
  detailsVersion: number,
  targetLang: ContentTargetLang,
  contentHash: string,
  claim: AuctionTranslationClaim,
  auction: Auction,
): Promise<void> {
  const { title, address, description } = auction
  const documentSummary = auction.extraction?.documentSummary ?? null
  const extractionTexts = extractTranslatableExtractionTexts(auction.extraction)
  const sourceLang = countryContentLanguage(auction.country)
  let attemptedConfigs: LlmConfig[] = []
  try {
    const cached = await readContentTranslation(db, contentHash, targetLang)
    if (cached) {
      await completeAuctionTranslation(db, platform, externalId, detailsVersion, targetLang, claim, cached)
      return
    }

    const configs = await resolveActiveLlmConfigChain(db)
    attemptedConfigs = configs
    if (configs.length === 0) throw new Error('LLM ist nicht konfiguriert')

    let result: TranslationResult | null = null
    for (const [index, config] of configs.entries()) {
      try {
        result = await tryTranslate(title, address, description, documentSummary, extractionTexts, targetLang, sourceLang, config)
        break
      } catch (err) {
        const isLast = index === configs.length - 1
        if (isLast || !isLlmProviderUnavailable(err)) throw err
        console.warn(`[translation-retry] ${config.provider ?? 'openai-compatible'}/${config.model} unavailable for ${platform}/${externalId}, trying next configured model: ${(err as Error).message}`)
      }
    }
    if (!result) throw new Error('LLM hat keine gültige Übersetzung geliefert')

    await writeContentTranslation(db, contentHash, targetLang, result.title, result.address, result.description, result.documentSummary, result.extractionTexts)
    await completeAuctionTranslation(db, platform, externalId, detailsVersion, targetLang, claim, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const failedFingerprint = attemptedConfigs.length > 0 ? fingerprintConfigChain(attemptedConfigs) : null
    await failAuctionTranslation(db, platform, externalId, detailsVersion, targetLang, claim, message, failedFingerprint)
    console.warn(`[translation-retry] failed for ${platform}:${externalId}/${targetLang}: ${message}`)
  }
}

export type TranslationRetryOutcome = 'started' | 'not_found' | 'already_running'

/** Single-row admin retry (settings translation card) — claims synchronously
 *  so the caller gets an immediate 409 on an already-running attempt, then
 *  lets the LLM call itself happen in the background; the card just re-polls
 *  its list. */
export async function retryAuctionTranslation(
  db: Pool,
  platform: string,
  externalId: string,
  targetLang: ContentTargetLang,
): Promise<TranslationRetryOutcome> {
  const record = await readAuctionRecord(platform, externalId)
  if (!record || record.detailsVersion == null) return 'not_found'
  const contentHash = auctionTranslationContentHash(record.auction)
  const claim = await claimAuctionTranslation(db, platform, externalId, record.detailsVersion, targetLang, contentHash)
  if (!claim) return 'already_running'
  void runRetry(db, platform, externalId, record.detailsVersion, targetLang, contentHash, claim, record.auction)
  return 'started'
}

// Bounded so a large open/failed backlog can't fire dozens of concurrent LLM
// calls at once (see gemini-tpm-pacing-fix in memory / PR #281) — each worker
// awaits one item's full claim+translate before picking up the next, unlike
// the single-row path above which is intentionally fire-and-forget.
const BULK_RETRY_CONCURRENCY = 3

/** Country-wide bulk retry (settings translation card's "offene"/"fehlerhafte"
 *  buttons) — best-effort per item, does not throw. */
export async function retryTranslationsBulk(
  db: Pool,
  items: { platform: string; externalId: string; lang: ContentTargetLang }[],
): Promise<void> {
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++]
      if (!item) continue
      try {
        const record = await readAuctionRecord(item.platform, item.externalId)
        if (!record || record.detailsVersion == null) continue
        const contentHash = auctionTranslationContentHash(record.auction)
        const claim = await claimAuctionTranslation(db, item.platform, item.externalId, record.detailsVersion, item.lang, contentHash)
        if (!claim) continue
        await runRetry(db, item.platform, item.externalId, record.detailsVersion, item.lang, contentHash, claim, record.auction)
      } catch (err) {
        console.warn(`[translation-retry-bulk] ${item.platform}:${item.externalId}/${item.lang}: ${(err as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: BULK_RETRY_CONCURRENCY }, worker))
}
