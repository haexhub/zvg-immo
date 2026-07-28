// Lazy LLM translation of one auction's title, description and document
// synthesis into a target language (?lang=de|en). Cache-first, with in-flight
// dedup, an in-memory rate limit, snapshot lookup and safe path segments.
// Cached by (content_hash, lang) in Postgres (content_translations) — the
// hash covers the translated fields plus the current document-set identity, so
// unrelated field changes never invalidate the cache but changed/withdrawn/new
// documents do. Auctions whose country's primary language already matches the
// target are passed through without an LLM call.

import { setResponseHeader, setResponseStatus, type H3Event } from 'h3'
import type { Pool } from 'pg'
import { readAuctionSnapshot } from '~/server/utils/auction-snapshot'
import { isSafePathSegment } from '~/server/utils/path-segment'
import { cacheKey } from '~/server/utils/verkehrswert-cache'
import { getPool } from '~/server/utils/db'
import { sha256Hex } from '~/server/utils/raw-archive'
import { readContentTranslation, writeContentTranslation } from '~/server/utils/content-translation'
import { getLlmMaxTokens, getLlmProviderOverride } from '~/server/utils/app-settings'
import { resolveLlmConfig } from '~/server/utils/extract/llm'
import { callTranslationLlm, type TranslationResult } from '~/server/utils/extract/text-llm'
import { isPassthroughLanguage, type ContentTargetLang } from '~/lib/content-language'
import { extractTranslatableExtractionTexts, TRANSLATABLE_EXTRACTION_TEXTS_VERSION } from '~/lib/extraction-translation'
import {
  checkInMemoryRateLimit,
  createInMemoryRateLimitState,
  recordInMemoryRateLimitHit,
} from '~/server/utils/in-memory-rate-limit'

const SUPPORTED_TARGET_LANGS = new Set<ContentTargetLang>(['de', 'en'])

const LANG_NAMES: Record<ContentTargetLang, string> = { de: 'German', en: 'English' }

const SYSTEM_PROMPT =
  'Du bist ein präziser Übersetzer für Anzeigen von Immobilien-Zwangsversteigerungen. ' +
  'Übersetze wörtlich und originalgetreu — keine Ausschmückung, keine Zusammenfassung. ' +
  'Alle vollständigen Sätze müssen in der Zielsprache stehen. Fach- und Rechtsbegriffe nur dann unverändert lassen, ' +
  'wenn es wirklich kein zuverlässiges Äquivalent gibt; keine Originalbegriffe mit Klammerübersetzung ausgeben.'

// Dedupe concurrent misses for the same content+language and cap total
// concurrent LLM work.
const inflight = new Map<string, Promise<TranslationResult>>()
const MAX_INFLIGHT = 4
const MAX_TRANSLATION_ATTEMPTS = 2
const TRANSLATION_RATE_LIMIT = { max: 30, windowMs: 60 * 60 * 1000, maxKeys: 10_000 }
const translationRateLimit = createInMemoryRateLimitState()

/** Builds a labelled prompt so nullable fields retain their identity. */
function buildPrompt(
  title: string | null,
  description: string | null,
  documentSummary: string | null,
  extractionTexts: ReturnType<typeof extractTranslatableExtractionTexts>,
  targetLang: ContentTargetLang,
): string {
  const lines = [
    `Translate the following real-estate foreclosure auction text fields into ${LANG_NAMES[targetLang]}.`,
    'Return the same JSON shape. Translate every string value. Keep nulls, array order, array lengths, identifiers, dates, numbers and currencies unchanged.',
    'Do not leave whole source-language sentences unchanged. Do not write source terms followed by target-language translations in parentheses; use the target-language term directly.',
    'EXTRACTION_TEXTS_JSON contains short structured labels shown in the property detail UI. Translate heating and insights.construction as user-facing amenity text, including material, roof, window, foundation and building-services terms. Keep an original specialist term only when there is no reliable target-language equivalent.',
    '',
    `TITLE: ${title ?? ''}`,
    `DESCRIPTION:\n${description ?? ''}`,
    `DOCUMENT_SUMMARY:\n${documentSummary ?? ''}`,
    `EXTRACTION_TEXTS_JSON:\n${JSON.stringify(extractionTexts ?? null, null, 2)}`,
  ]
  return lines.join('\n')
}

function clientKey(event: H3Event): string {
  const trustForwardedFor = String(useRuntimeConfig().trustForwardedFor ?? '') === '1'
  if (trustForwardedFor) {
    const forwarded = getRequestHeader(event, 'x-forwarded-for')
    const first = forwarded?.split(',')[0]?.trim()
    if (first) return first
    const realIp = getRequestHeader(event, 'x-real-ip')?.trim()
    if (realIp) return realIp
  }
  return event.node.req.socket.remoteAddress ?? 'unknown'
}

async function tryTranslate(
  title: string | null,
  description: string | null,
  documentSummary: string | null,
  extractionTexts: ReturnType<typeof extractTranslatableExtractionTexts>,
  targetLang: ContentTargetLang,
  config: Parameters<typeof callTranslationLlm>[6],
  attempts = MAX_TRANSLATION_ATTEMPTS,
): Promise<TranslationResult | null> {
  const prompt = buildPrompt(title, description, documentSummary, extractionTexts, targetLang)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await callTranslationLlm(
      SYSTEM_PROMPT,
      prompt,
      title,
      description,
      documentSummary,
      extractionTexts,
      config,
      targetLang,
    )
    if (result) return result
  }
  return null
}

async function tryTranslateInParts(
  title: string | null,
  description: string | null,
  documentSummary: string | null,
  extractionTexts: ReturnType<typeof extractTranslatableExtractionTexts>,
  targetLang: ContentTargetLang,
  config: Parameters<typeof callTranslationLlm>[6],
): Promise<TranslationResult | null> {
  const textResult = title != null || description != null || documentSummary != null
    ? await tryTranslate(title, description, documentSummary, null, targetLang, config)
    : { title: null, description: null, documentSummary: null, extractionTexts: null }
  if (!textResult) return null

  const extractionResult = extractionTexts
    ? await tryTranslate(null, null, null, extractionTexts, targetLang, config)
    : { title: null, description: null, documentSummary: null, extractionTexts: null }
  if (!extractionResult) return null

  return {
    title: textResult.title,
    description: textResult.description,
    documentSummary: textResult.documentSummary,
    extractionTexts: extractionResult.extractionTexts,
  }
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

  const { title, description } = auction
  const documentSummary = auction.extraction?.documentSummary ?? null
  const extractionTexts = extractTranslatableExtractionTexts(auction.extraction)
  if (title == null && description == null && documentSummary == null && extractionTexts == null) {
    return { title: null, description: null, documentSummary: null, extractionTexts: null, translated: false }
  }

  if (isPassthroughLanguage(auction.country, targetLang)) {
    return { title, description, documentSummary, extractionTexts, translated: false }
  }

  const contentHash = sha256Hex(Buffer.from(JSON.stringify({
    title,
    description,
    documentSummary,
    extractionTexts,
    extractionTextsVersion: TRANSLATABLE_EXTRACTION_TEXTS_VERSION,
    documentSetHash: auction.extraction?.documentSetHash ?? null,
    documentSetVersion: auction.extraction?.documentSetVersion ?? null,
  })))
  const inflightKey = `${contentHash}:${targetLang}`

  const db: Pool | null = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'translation cache not configured' })
  }

  const cached = await readContentTranslation(db, contentHash, targetLang)
  if (cached) {
    setResponseHeader(event, 'x-zvg-translation-cache', 'hit')
    return {
      title: cached.title,
      description: cached.description,
      documentSummary: cached.documentSummary,
      extractionTexts: cached.extractionTexts,
      translated: true,
    }
  }

  const existing = inflight.get(inflightKey)
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

  const llmCfg = useRuntimeConfig().extractLlm as
    | { provider?: string; baseUrl?: string; apiKey?: string; model?: string }
    | undefined
  const translationOverride = await getLlmProviderOverride(db, 'translation').catch(() => null)
  const extractionOverride = translationOverride ? null : await getLlmProviderOverride(db, 'extraction').catch(() => null)
  const config = resolveLlmConfig(translationOverride ?? extractionOverride ?? llmCfg, {
    maxTokens: await getLlmMaxTokens(db, 'translation'),
  })
  if (!config) {
    throw createError({ statusCode: 503, statusMessage: 'LLM not configured' })
  }

  const now = Date.now()
  const requester = clientKey(event)
  if (!checkInMemoryRateLimit(translationRateLimit, requester, now, TRANSLATION_RATE_LIMIT)) {
    throw createError({ statusCode: 429, statusMessage: 'translation rate limit exceeded' })
  }
  recordInMemoryRateLimitHit(translationRateLimit, requester, now, TRANSLATION_RATE_LIMIT)

  const gen = (async () => {
    const result = await tryTranslate(title, description, documentSummary, extractionTexts, targetLang, config)
      ?? await tryTranslateInParts(title, description, documentSummary, extractionTexts, targetLang, config)
    if (!result) {
      throw createError({ statusCode: 502, statusMessage: 'LLM did not return a translation' })
    }
    await writeContentTranslation(
      db,
      contentHash,
      targetLang,
      result.title,
      result.description,
      result.documentSummary,
      result.extractionTexts,
    )
    setResponseHeader(event, 'x-zvg-translation-cache', 'generated')
    return result
  })()

  inflight.set(inflightKey, gen)
  try {
    return { ...(await gen), translated: true }
  } finally {
    inflight.delete(inflightKey)
  }
})
