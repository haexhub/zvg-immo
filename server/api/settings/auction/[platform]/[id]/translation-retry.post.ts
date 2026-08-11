// Admin single-auction translation (re)trigger for the /settings translation-
// status card. Unlike the public translation endpoint (server/api/auction/
// [platform]/[id]/translation.post.ts), this bypasses the 1h failed-attempt
// backoff entirely — an explicit admin click is exactly the "retry now"
// escape hatch that endpoint already has for a changed LLM config, just
// without requiring the config to have changed. claimAuctionTranslation
// itself has no time-based gate on a 'failed' row (only the read path in
// translation.post.ts enforces retryDue), so calling it directly here is
// enough; no separate bypass flag is needed.
//
// Detached like the other single-auction admin triggers (auction-admin-
// trial.ts's runAdminTrialReprocess): a translation call can still take a
// few seconds, and /settings has no dedicated status endpoint to await —
// the translation-status card just re-polls its list.

import { isSafePathSegment } from '~/server/utils/path-segment'
import { getPool } from '~/server/utils/db'
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
import { recordLlmUsage } from '~/server/utils/llm-usage'
import { countryContentLanguage, type ContentTargetLang } from '~/lib/content-language'
import { extractTranslatableExtractionTexts } from '~/lib/extraction-translation'
import {
  SUPPORTED_TARGET_LANGS,
  auctionTranslationContentHash,
  tryTranslate,
} from '~/server/api/auction/[platform]/[id]/translation.post'
import type { Pool } from 'pg'
import type { Auction } from '~/types/auction'

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
        result = await tryTranslate(title, address, description, documentSummary, extractionTexts, targetLang, sourceLang, config, (usage) => {
          void recordLlmUsage({
            task: 'translation',
            executionMode: 'sync',
            source: null,
            provider: config.provider ?? 'openai-compatible',
            model: config.model,
            profileId: config.profileId ?? null,
            platform,
            externalId,
            usage,
          })
        })
        break
      } catch (err) {
        const isLast = index === configs.length - 1
        if (isLast || !isLlmProviderUnavailable(err)) throw err
        console.warn(`[settings/translation-retry] ${config.provider ?? 'openai-compatible'}/${config.model} unavailable for ${platform}/${externalId}, trying next configured model: ${(err as Error).message}`)
      }
    }
    if (!result) throw new Error('LLM hat keine gültige Übersetzung geliefert')

    await writeContentTranslation(db, contentHash, targetLang, result.title, result.address, result.description, result.documentSummary, result.extractionTexts)
    await completeAuctionTranslation(db, platform, externalId, detailsVersion, targetLang, claim, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const failedFingerprint = attemptedConfigs.length > 0 ? fingerprintConfigChain(attemptedConfigs) : null
    await failAuctionTranslation(db, platform, externalId, detailsVersion, targetLang, claim, message, failedFingerprint)
    console.warn(`[settings/translation-retry] failed for ${platform}:${externalId}/${targetLang}: ${message}`)
  }
}

export default defineEventHandler(async (event) => {
  const platform = String(getRouterParam(event, 'platform') ?? '')
  const id = String(getRouterParam(event, 'id') ?? '')
  if (!isSafePathSegment(platform) || !isSafePathSegment(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id' })
  }
  const body = await readBody<{ lang?: string }>(event).catch(() => undefined) ?? {}
  if (!SUPPORTED_TARGET_LANGS.has(body.lang as ContentTargetLang)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid or missing lang' })
  }
  const targetLang = body.lang as ContentTargetLang

  const db = getPool()
  if (!db) throw createError({ statusCode: 503, statusMessage: 'translation cache not configured' })

  const record = await readAuctionRecord(platform, id)
  if (!record || record.detailsVersion == null) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }
  const contentHash = auctionTranslationContentHash(record.auction)
  const claim = await claimAuctionTranslation(db, platform, id, record.detailsVersion, targetLang, contentHash)
  if (!claim) {
    throw createError({ statusCode: 409, statusMessage: 'Übersetzung läuft bereits.' })
  }

  void runRetry(db, platform, id, record.detailsVersion, targetLang, contentHash, claim, record.auction)
  return { started: true }
})
