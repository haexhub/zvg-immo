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
import { readAuctionSnapshot } from '~/server/utils/auction-snapshot'
import { readLatestAuctionDetails } from '~/server/utils/auction-details'
import { isSafePathSegment } from '~/server/utils/path-segment'
import { cacheKey } from '~/server/utils/verkehrswert-cache'
import { getPool } from '~/server/utils/db'
import { sha256Hex } from '~/server/utils/raw-archive'
import {
  claimAuctionTranslation,
  completeAuctionTranslation,
  failAuctionTranslation,
  readAuctionTranslation,
  readContentTranslation,
  writeContentTranslation,
} from '~/server/utils/content-translation'
import { isLlmProviderUnavailable, type LlmConfig } from '~/server/utils/extract/llm'
import { callTranslationLlm, type TranslationResult } from '~/server/utils/extract/text-llm'
import { fingerprintConfigChain, resolveActiveLlmConfigChain } from '~/server/utils/translation-llm-chain'
import { countryContentLanguage, isPassthroughLanguage, type ContentTargetLang } from '~/lib/content-language'
import { extractTranslatableExtractionTexts, translationContentSource } from '~/lib/extraction-translation'
import {
  checkInMemoryRateLimit,
  createInMemoryRateLimitState,
  recordInMemoryRateLimitHit,
} from '~/server/utils/in-memory-rate-limit'
import { requestClientIp } from '~/server/utils/request-client-ip'
import type { Auction } from '~/types/auction'

const SUPPORTED_TARGET_LANGS = new Set<ContentTargetLang>(['de', 'en'])

const LANG_NAMES: Record<ContentTargetLang, string> = { de: 'German', en: 'English' }
const LANGUAGE_DISPLAY_NAMES = new Intl.DisplayNames(['en'], { type: 'language' })

function languageName(code: string): string {
  return LANGUAGE_DISPLAY_NAMES.of(code) ?? code
}

const SYSTEM_PROMPT =
  'Du bist ein präziser Übersetzer für Anzeigen von Immobilien-Zwangsversteigerungen. ' +
  'Übersetze wörtlich und originalgetreu — keine Ausschmückung, keine Zusammenfassung. ' +
  'Alle vollständigen Sätze müssen in der Zielsprache stehen. Fach- und Rechtsbegriffe nur dann unverändert lassen, ' +
  'wenn es wirklich kein zuverlässiges Äquivalent gibt; keine Originalbegriffe mit Klammerübersetzung ausgeben.'

// Dedupe concurrent misses for the same content+language and cap total
// concurrent LLM work.
const inflight = new Map<string, Promise<TranslationResult>>()
const MAX_INFLIGHT = 4
const TRANSLATION_RATE_LIMIT = { max: 30, windowMs: 60 * 60 * 1000, maxKeys: 10_000 }
const translationRateLimit = createInMemoryRateLimitState()

/** Builds a labelled prompt so nullable fields retain their identity. */
function buildPrompt(
  title: string | null,
  address: string | null,
  description: string | null,
  documentSummary: string | null,
  extractionTexts: ReturnType<typeof extractTranslatableExtractionTexts>,
  targetLang: ContentTargetLang,
  sourceLang: string | null,
): string {
  const sourceHint = sourceLang
    ? `The source portal normally publishes this auction in ${languageName(sourceLang)}. If an individual field is in another language, detect it and still translate it into ${LANG_NAMES[targetLang]}.`
    : `Detect the source language of each field and translate it into ${LANG_NAMES[targetLang]}.`
  const lines = [
    `Translate the following real-estate foreclosure auction text fields into ${LANG_NAMES[targetLang]}.`,
    sourceHint,
    'Return the same JSON shape. Translate every string value. Keep nulls, array order, array lengths, identifiers, dates, numbers and currencies unchanged.',
    'Do not leave whole source-language sentences unchanged. Do not write source terms followed by target-language translations in parentheses; use the target-language term directly.',
    'ADDRESS is a property address, not prose: localize administrative terms/abbreviations (street, square, district, house-number sign, place-name prefixes) into the target-language convention, and transliterate non-Latin-script proper nouns into Latin script. Keep the same component order; do not invent or drop components.',
    'EXTRACTION_TEXTS_JSON contains short structured labels shown in the property detail UI. Translate heating and insights.construction as user-facing amenity text, including material, roof, window, foundation and building-services terms. Keep an original specialist term only when there is no reliable target-language equivalent.',
    '',
    `TITLE: ${title ?? ''}`,
    `ADDRESS: ${address ?? ''}`,
    `DESCRIPTION:\n${description ?? ''}`,
    `DOCUMENT_SUMMARY:\n${documentSummary ?? ''}`,
    `EXTRACTION_TEXTS_JSON:\n${JSON.stringify(extractionTexts ?? null, null, 2)}`,
  ]
  return lines.join('\n')
}

async function tryTranslate(
  title: string | null,
  address: string | null,
  description: string | null,
  documentSummary: string | null,
  extractionTexts: ReturnType<typeof extractTranslatableExtractionTexts>,
  targetLang: ContentTargetLang,
  sourceLang: string | null,
  config: Parameters<typeof callTranslationLlm>[7],
): Promise<TranslationResult | null> {
  return await callTranslationLlm(
    SYSTEM_PROMPT,
    buildPrompt(title, address, description, documentSummary, extractionTexts, targetLang, sourceLang),
    title,
    address,
    description,
    documentSummary,
    extractionTexts,
    config,
  )
}

export function auctionTranslationContentHash(auction: Pick<Auction, 'title' | 'address' | 'description' | 'extraction'>): string {
  return sha256Hex(Buffer.from(JSON.stringify(translationContentSource(auction))))
}

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

  const key = cacheKey(platform, id)
  const snapshot = await readAuctionSnapshot()
  const auction = snapshot[key]
  if (!auction) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }

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
  const latestDetails = await readLatestAuctionDetails(platform, id)
  if (!latestDetails) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }
  const detailsVersion = latestDetails.version

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
      throw createError({
        statusCode: 502,
        statusMessage: 'Übersetzung fehlgeschlagen',
        data: { detail: stored.errorMessage ?? 'Unbekannter Übersetzungsfehler' },
      })
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
          result = await tryTranslate(title, address, description, documentSummary, extractionTexts, targetLang, sourceLang, config)
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
      throw createError({
        statusCode: 502,
        statusMessage: 'Übersetzung fehlgeschlagen',
        data: { detail: message },
      })
    }
  })()

  inflight.set(inflightKey, gen)
  try {
    return { ...(await gen), translated: true }
  } finally {
    inflight.delete(inflightKey)
  }
})
