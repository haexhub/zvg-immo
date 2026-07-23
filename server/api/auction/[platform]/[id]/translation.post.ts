// Lazy LLM translation of one auction's title+description into a target
// language (?lang=de|en). Mirrors summary.post.ts's structure: cache-first,
// in-flight dedup, in-memory rate limit, snapshot lookup, isSafePathSegment.
// Cached by (content_hash, lang) in Postgres (content_translations) — the
// hash covers only title+description, so unrelated field changes never
// invalidate a cached translation, and an actual content edit mints a new
// hash and triggers a fresh translation. Auctions whose country's primary
// language already matches the target are passed through without an LLM call.

import type { H3Event } from 'h3'
import type { Pool } from 'pg'
import { readAuctionSnapshot } from '../../../../utils/auction-snapshot'
import { isSafePathSegment } from '../../../../utils/path-segment'
import { cacheKey } from '../../../../utils/verkehrswert-cache'
import { getPool } from '../../../../utils/db'
import { sha256Hex } from '../../../../utils/raw-archive'
import { readContentTranslation, writeContentTranslation } from '../../../../utils/content-translation'
import { resolveLlmConfig } from '../../../../utils/extract/llm'
import { callTranslationLlm, type TranslationResult } from '../../../../utils/extract/text-llm'
import { isPassthroughLanguage, type ContentTargetLang } from '~/lib/content-language'
import {
  checkInMemoryRateLimit,
  createInMemoryRateLimitState,
  recordInMemoryRateLimitHit,
} from '../../../../utils/in-memory-rate-limit'

const SUPPORTED_TARGET_LANGS = new Set<ContentTargetLang>(['de', 'en'])

const LANG_NAMES: Record<ContentTargetLang, string> = { de: 'German', en: 'English' }

const SYSTEM_PROMPT =
  'Du bist ein präziser Übersetzer für Anzeigen von Immobilien-Zwangsversteigerungen. ' +
  'Übersetze wörtlich und originalgetreu — keine Ausschmückung, keine Zusammenfassung. ' +
  'Fach- und Rechtsbegriffe unverändert lassen, wenn eine wörtliche Übersetzung den Sinn verfälschen würde.'

// Same rationale as summary.post.ts: dedupe concurrent misses for the same
// (auction, lang) and cap total concurrent LLM work.
const inflight = new Map<string, Promise<TranslationResult>>()
const MAX_INFLIGHT = 4
const TRANSLATION_RATE_LIMIT = { max: 30, windowMs: 60 * 60 * 1000, maxKeys: 10_000 }
const translationRateLimit = createInMemoryRateLimitState()

function buildPrompt(title: string | null, description: string | null, targetLang: ContentTargetLang): string {
  const lines = [
    `Translate the following real-estate foreclosure auction text fields into ${LANG_NAMES[targetLang]}.`,
    '',
    `TITLE: ${title ?? ''}`,
    `DESCRIPTION:\n${description ?? ''}`,
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

  const key = cacheKey(platform, id)
  const snapshot = await readAuctionSnapshot()
  const auction = snapshot[key]
  if (!auction) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }

  const { title, description } = auction
  if (title == null && description == null) {
    return { title: null, description: null, translated: false }
  }

  if (isPassthroughLanguage(auction.country, targetLang)) {
    return { title, description, translated: false }
  }

  const contentHash = sha256Hex(Buffer.from(JSON.stringify({ title, description })))
  const inflightKey = `${contentHash}:${targetLang}`

  const db: Pool | null = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'translation cache not configured' })
  }

  const cached = await readContentTranslation(db, contentHash, targetLang)
  if (cached) {
    return { title: cached.title, description: cached.description, translated: true }
  }

  const existing = inflight.get(inflightKey)
  if (existing) {
    return { ...(await existing), translated: true }
  }
  if (inflight.size >= MAX_INFLIGHT) {
    throw createError({ statusCode: 429, statusMessage: 'translation generation busy, retry shortly' })
  }

  const llmCfg = useRuntimeConfig().extractLlm as
    | { provider?: string; baseUrl?: string; apiKey?: string; model?: string }
    | undefined
  const config = resolveLlmConfig(llmCfg, { maxTokens: 8192 })
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
    const result = await callTranslationLlm(
      SYSTEM_PROMPT,
      buildPrompt(title, description, targetLang),
      title,
      description,
      config,
    )
    if (!result) {
      throw createError({ statusCode: 502, statusMessage: 'LLM did not return a translation' })
    }
    await writeContentTranslation(db, contentHash, targetLang, result.title, result.description)
    return result
  })()

  inflight.set(inflightKey, gen)
  try {
    return { ...(await gen), translated: true }
  } finally {
    inflight.delete(inflightKey)
  }
})
