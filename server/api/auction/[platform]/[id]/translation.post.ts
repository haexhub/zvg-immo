// Lazy LLM translation of one auction's title, address, description and
// document synthesis into a target language (?lang=de|en). Cache-first, with in-flight
// dedup, an in-memory rate limit, snapshot lookup and safe path segments.
// Cached by (content_hash, lang) in Postgres (content_translations) — the
// hash covers the translated fields plus the current document-set identity, so
// unrelated field changes never invalidate the cache but changed/withdrawn/new
// documents do. Auctions whose country's primary language already matches the
// target are passed through without an LLM call.

import { setResponseHeader, setResponseStatus } from 'h3'
import type { Pool } from 'pg'
import { readAuctionRecord } from '~/server/utils/auction-record'
import { isSafePathSegment } from '~/server/utils/path-segment'
import { getPool } from '~/server/utils/db'
import { publicError } from '~/server/utils/public-error'
import {
  claimAuctionTranslation,
  completeAuctionTranslation,
  failAuctionTranslation,
  readAuctionTranslation,
  readContentTranslation,
  writeContentTranslation,
} from '~/server/utils/content-translation'
import { isLlmProviderUnavailable, type LlmConfig } from '~/server/utils/extract/llm'
import type { TranslationResult } from '~/server/utils/extract/text-llm'
import { fingerprintConfigChain, resolveActiveLlmConfigChain } from '~/server/utils/translation-llm-chain'
import { recordLlmUsage } from '~/server/utils/llm-usage'
import { CONTENT_TARGET_LANGS, countryContentLanguage, isPassthroughLanguage, type ContentTargetLang } from '~/lib/content-language'
import { extractTranslatableExtractionTexts } from '~/lib/extraction-translation'
import {
  checkInMemoryRateLimit,
  createInMemoryRateLimitState,
  recordInMemoryRateLimitHit,
} from '~/server/utils/in-memory-rate-limit'
import { requestClientIp } from '~/server/utils/request-client-ip'
import { auctionTranslationContentHash, translationSourceAuction, tryTranslate } from '~/server/utils/auction-translation'

// Exported so the /settings per-auction retry trigger (translation-retry.post.ts)
// validates the same language set.
export const SUPPORTED_TARGET_LANGS = new Set<ContentTargetLang>(CONTENT_TARGET_LANGS)

// Dedupe concurrent misses for the same content+language and cap total
// concurrent LLM work.
const inflight = new Map<string, Promise<TranslationResult>>()
const MAX_INFLIGHT = 4
const TRANSLATION_RATE_LIMIT = { max: 30, windowMs: 60 * 60 * 1000, maxKeys: 10_000 }
const translationRateLimit = createInMemoryRateLimitState()

export default defineEventHandler(async (event) => {
  const platform = String(event.context.params?.platform ?? '')
  const id = String(event.context.params?.id ?? '')
  if (!isSafePathSegment(platform) || !isSafePathSegment(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id' })
  }

  const lang = String(getQuery(event).lang ?? '')
  if (!SUPPORTED_TARGET_LANGS.has(lang as ContentTargetLang)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid or missing lang' })
  }
  const targetLang = lang as ContentTargetLang
  const cacheOnly = String(getQuery(event).cacheOnly ?? '') === '1'

  const record = await readAuctionRecord(platform, id)
  if (!record) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }
  const auction = translationSourceAuction(record.auction)

  const { title, address, description } = auction
  const documentSummary = auction.extraction?.documentSummary ?? null
  const extractionTexts = extractTranslatableExtractionTexts(auction.extraction)
  const sourceLang = countryContentLanguage(auction.country)
  if (title == null && address == null && description == null && documentSummary == null && extractionTexts == null) {
    return { title: null, address: null, description: null, documentSummary: null, extractionTexts: null, translated: false }
  }

  if (isPassthroughLanguage(auction.country, targetLang)) {
    return { title, address, description, documentSummary, extractionTexts, translated: false }
  }

  const contentHash = auctionTranslationContentHash(auction)
  // Dedupe only the same auction/language/content snapshot. A content-hash-only
  // key could let a second auction hitchhike without creating its own durable
  // once-only row, while omitting the hash could reuse stale in-memory work.
  const inflightKey = `${platform}:${id}:${targetLang}:${contentHash}`

  const db: Pool | null = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'translation cache not configured' })
  }

  // Translations hang off a concrete extraction version (WP-4). An auction
  // with no auction_details row yet has nothing versioned to translate.
  if (record.detailsVersion == null) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }
  const detailsVersion = record.detailsVersion

  const stored = await readAuctionTranslation(db, platform, id, detailsVersion, targetLang)
  if (stored?.status === 'completed' && stored.contentHash === contentHash) {
    setResponseHeader(event, 'x-zvg-translation-cache', 'hit')
    return {
      title: stored.title,
      address: stored.address,
      description: stored.description,
      documentSummary: stored.documentSummary,
      extractionTexts: stored.extractionTexts,
      translated: true,
    }
  }
  // A failed attempt is served as its error until the retry window opens; a
  // pending claim blocks until its lease expires. Both then fall through to
  // claimAuctionTranslation, which takes the stale row over — a transient
  // provider failure must not lock this auction out permanently.
  const existing = inflight.get(inflightKey)
  if (stored?.status === 'failed' && !stored.retryDue) {
    const configs = await resolveActiveLlmConfigChain(db)
    const currentFingerprint = configs.length > 0 ? fingerprintConfigChain(configs) : null
    // Same chain that failed before: still within the backoff window, keep
    // replaying the stored error. A /settings change to any link in the chain
    // (primary or a fallback — added, removed, reordered or fixed) produces a
    // different fingerprint — skip the wait, retry now. A null failedConfig (a
    // row written before this fingerprint existed) is "unknown, assume
    // unchanged" — otherwise every pre-existing failed row would bypass the
    // backoff the first time it's touched after this ships.
    if (stored.failedConfig == null || stored.failedConfig === currentFingerprint) {
      throw publicError(
        'POST /api/auction/:platform/:id/translation',
        502,
        'Übersetzung fehlgeschlagen.',
        stored.errorMessage ?? 'Unbekannter Übersetzungsfehler',
      )
    }
  }
  if (stored?.status === 'pending' && !stored.claimStale) {
    setResponseHeader(event, 'x-zvg-translation-cache', 'inflight')
    if (cacheOnly) {
      setResponseStatus(event, 204)
      return null
    }
    if (existing) {
      return { ...(await existing), translated: true }
    }
    throw createError({ statusCode: 409, statusMessage: 'Übersetzung läuft bereits' })
  }

  if (cacheOnly) {
    setResponseHeader(event, 'x-zvg-translation-cache', existing ? 'inflight' : 'miss')
    setResponseStatus(event, 204)
    return null
  }
  if (existing) {
    setResponseHeader(event, 'x-zvg-translation-cache', 'inflight')
    return { ...(await existing), translated: true }
  }
  if (inflight.size >= MAX_INFLIGHT) {
    throw createError({ statusCode: 429, statusMessage: 'translation generation busy, retry shortly' })
  }

  const now = Date.now()
  const requester = requestClientIp(event)
  if (!checkInMemoryRateLimit(translationRateLimit, requester, now, TRANSLATION_RATE_LIMIT)) {
    throw createError({ statusCode: 429, statusMessage: 'translation rate limit exceeded' })
  }
  recordInMemoryRateLimitHit(translationRateLimit, requester, now, TRANSLATION_RATE_LIMIT)

  const claim = await claimAuctionTranslation(db, platform, id, detailsVersion, targetLang, contentHash)
  if (!claim) {
    throw createError({ statusCode: 409, statusMessage: 'Übersetzung wurde bereits angestoßen' })
  }

  // Populated inside gen() with whatever chain was actually resolved for this
  // attempt, so a failure below fingerprints the whole attempted chain (not
  // just one link) — see fingerprintConfigChain.
  let attemptedConfigs: LlmConfig[] = []
  const gen = (async () => {
    try {
      const cached = await readContentTranslation(db, contentHash, targetLang)
      if (cached) {
        await completeAuctionTranslation(db, platform, id, detailsVersion, targetLang, claim, cached)
        setResponseHeader(event, 'x-zvg-translation-cache', 'hit')
        return cached
      }

      // Always resolves the full chain fresh here (rather than reusing the
      // pre-claim check's resolution) — this only re-runs on the already-slow
      // retry-a-failed-attempt path, so one extra resolve is a fine trade for
      // not threading the resolved chain through here.
      const configs = await resolveActiveLlmConfigChain(db)
      attemptedConfigs = configs
      if (configs.length === 0) {
        throw new Error('LLM ist nicht konfiguriert')
      }

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
              externalId: id,
              usage,
            })
          })
          break
        } catch (err) {
          const isLast = index === configs.length - 1
          if (isLast || !isLlmProviderUnavailable(err)) throw err
          console.warn(
            `[translation] ${config.provider ?? 'openai-compatible'}/${config.model} unavailable for ${platform}/${id}, trying next configured model: ${(err as Error).message}`,
          )
        }
      }
      if (!result) {
        throw new Error('LLM hat keine gültige Übersetzung geliefert')
      }
      await writeContentTranslation(
        db,
        contentHash,
        targetLang,
        result.title,
        result.address,
        result.description,
        result.documentSummary,
        result.extractionTexts,
      )
      await completeAuctionTranslation(db, platform, id, detailsVersion, targetLang, claim, result)
      setResponseHeader(event, 'x-zvg-translation-cache', 'generated')
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const failedFingerprint = attemptedConfigs.length > 0 ? fingerprintConfigChain(attemptedConfigs) : null
      await failAuctionTranslation(db, platform, id, detailsVersion, targetLang, claim, message, failedFingerprint)
      throw publicError('POST /api/auction/:platform/:id/translation', 502, 'Übersetzung fehlgeschlagen.', message)
    }
  })()

  inflight.set(inflightKey, gen)
  try {
    return { ...(await gen), translated: true }
  } finally {
    inflight.delete(inflightKey)
  }
})
