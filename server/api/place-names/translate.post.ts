// Batch-translates/transliterates OSM-derived place names (nearby
// settlements, industrial sites, airports — see osm-location-shared.ts's
// nameOf()) for the detail page's location section. Cached per (name, lang)
// in place_name_translations, shared across every auction that references the
// same place — unlike auction-scoped translation.post.ts, there is no
// claim/pending/retry-lockout state here: a cache miss just degrades to the
// original native name, so a soft failure (LLM unavailable) returns whatever
// was already cached instead of a hard error.

import type { Pool } from 'pg'
import { getPool } from '~/server/utils/db'
import { isLlmProviderUnavailable } from '~/server/utils/extract/llm'
import { callPlaceNameTranslationLlm } from '~/server/utils/extract/text-llm'
import { resolveActiveLlmConfigChain } from '~/server/utils/translation-llm-chain'
import { readPlaceNameTranslations, writePlaceNameTranslations } from '~/server/utils/place-name-translation'
import type { ContentTargetLang } from '~/lib/content-language'
import {
  checkInMemoryRateLimit,
  createInMemoryRateLimitState,
  recordInMemoryRateLimitHit,
} from '~/server/utils/in-memory-rate-limit'
import { requestClientIp } from '~/server/utils/request-client-ip'

const SUPPORTED_TARGET_LANGS = new Set<ContentTargetLang>(['de', 'en'])
const MAX_NAMES_PER_REQUEST = 40
const MAX_NAME_LENGTH = 200
const LANGUAGE_DISPLAY_NAMES = new Intl.DisplayNames(['en'], { type: 'language' })
const RATE_LIMIT = { max: 60, windowMs: 60 * 60 * 1000, maxKeys: 10_000 }
const rateLimitState = createInMemoryRateLimitState()

interface RequestBody {
  names?: unknown
  lang?: unknown
}

async function translateMissing(db: Pool, names: string[], lang: ContentTargetLang): Promise<Map<string, string>> {
  const configs = await resolveActiveLlmConfigChain(db)
  const languageName = LANGUAGE_DISPLAY_NAMES.of(lang) ?? lang
  for (const config of configs) {
    try {
      const translated = await callPlaceNameTranslationLlm(names, languageName, config)
      if (!translated) continue
      const entries = names.map((name, i) => ({ name, translated: translated[i]! }))
      await writePlaceNameTranslations(db, lang, entries)
      return new Map(entries.map((e) => [e.name, e.translated]))
    } catch (err) {
      if (!isLlmProviderUnavailable(err)) {
        console.warn(`[place-names/translate] ${config.provider ?? 'openai-compatible'}/${config.model} failed: ${(err as Error).message}`)
        continue
      }
    }
  }
  return new Map()
}

export default defineEventHandler(async (event) => {
  const body = await readBody<RequestBody>(event)
  const lang = String(body?.lang ?? '')
  if (!SUPPORTED_TARGET_LANGS.has(lang as ContentTargetLang)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid or missing lang' })
  }
  const targetLang = lang as ContentTargetLang

  const rawNames = Array.isArray(body?.names) ? body.names : []
  const names = [...new Set(
    rawNames
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.trim())
      .filter((name) => name.length > 0 && name.length <= MAX_NAME_LENGTH),
  )].slice(0, MAX_NAMES_PER_REQUEST)
  if (names.length === 0) return { translations: {} }

  const db = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'translation cache not configured' })
  }

  const cached = await readPlaceNameTranslations(db, names, targetLang)
  const missing = names.filter((name) => !cached.has(name))
  if (missing.length === 0) {
    return { translations: Object.fromEntries(cached) }
  }

  const now = Date.now()
  const requester = requestClientIp(event)
  if (!checkInMemoryRateLimit(rateLimitState, requester, now, RATE_LIMIT)) {
    throw createError({ statusCode: 429, statusMessage: 'translation rate limit exceeded' })
  }
  recordInMemoryRateLimitHit(rateLimitState, requester, now, RATE_LIMIT)

  const generated = await translateMissing(db, missing, targetLang)
  return { translations: Object.fromEntries(new Map([...cached, ...generated])) }
})
