// Generic on-demand LLM insight endpoint (Family A framework) — parameterized
// by the registry entry matching :insightId (server/utils/insights/registry.ts)
// instead of one bespoke endpoint per feature. Modeled on translation.post.ts's
// plumbing: cache-first (auction_insights, content-hash keyed), in-flight
// dedup, per-insight in-memory rate limit, snapshot lookup, safe path segments.
// A failed/empty LLM result is never cached — same contract as
// translation.post.ts, so a transient failure can always be retried instead of
// permanently locking that content-hash out of ever getting a real insight.

import { setResponseHeader } from 'h3'
import type { Pool } from 'pg'
import { readAuctionRecord } from '~/server/utils/auction-record'
import { isSafePathSegment } from '~/server/utils/path-segment'
import { getPool } from '~/server/utils/db'
import { sha256Hex } from '~/server/utils/raw-archive'
import { readInsight, writeInsight } from '~/server/utils/insight-cache'
import { getLlmMaxTokens, getLlmProviderOverride } from '~/server/utils/app-settings'
import { getProvider, resolveLlmConfig } from '~/server/utils/extract/llm'
import { getInsightDefinition } from '~/server/utils/insights/registry'
import {
  checkInMemoryRateLimit,
  createInMemoryRateLimitState,
  recordInMemoryRateLimitHit,
} from '~/server/utils/in-memory-rate-limit'
import { requestClientIp } from '~/server/utils/request-client-ip'

// Dedupe concurrent misses for the same insight+content-hash and cap total
// concurrent LLM work — same constant as translation.post.ts.
const inflight = new Map<string, Promise<{ payload: unknown, at: string }>>()
const MAX_INFLIGHT = 4

// One shared state for every insight; the rate-limit key includes insightId
// (see below) so two insights with different limits never share a budget.
const insightRateLimit = createInMemoryRateLimitState()
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000

export default defineEventHandler(async (event) => {
  const platform = String(event.context.params?.platform ?? '')
  const id = String(event.context.params?.id ?? '')
  const insightId = String(event.context.params?.insightId ?? '')
  if (!isSafePathSegment(platform) || !isSafePathSegment(id) || !isSafePathSegment(insightId)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id/insightId' })
  }

  const definition = getInsightDefinition(insightId)
  if (!definition) {
    throw createError({ statusCode: 404, statusMessage: 'unknown insight' })
  }

  const db: Pool | null = getPool()
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'insight cache not configured' })
  }

  const record = await readAuctionRecord(platform, id)
  if (!record) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }
  const auction = record.auction

  const contentHash = sha256Hex(Buffer.from(JSON.stringify({
    ...definition.buildContentHashInput(auction),
    promptVersion: definition.promptVersion,
  })))

  const cached = await readInsight(db, insightId, contentHash)
  if (cached) {
    setResponseHeader(event, 'x-zvg-insight-cache', 'hit')
    return { payload: cached.payload, at: cached.at }
  }

  const inflightKey = `${insightId}:${contentHash}`
  const existing = inflight.get(inflightKey)
  if (existing) {
    setResponseHeader(event, 'x-zvg-insight-cache', 'inflight')
    return await existing
  }
  if (inflight.size >= MAX_INFLIGHT) {
    throw createError({ statusCode: 429, statusMessage: 'insight generation busy, retry shortly' })
  }

  // Everything below is async (or depends on an async result), so it must run
  // inside `gen` — not between the inflight check above and inflight.set()
  // below — otherwise two concurrent misses for the same key both slip past
  // the check before either registers, and both fire an LLM call.
  const gen = (async () => {
    const llmCfg = useRuntimeConfig().extractLlm as
      | { provider?: string; baseUrl?: string; apiKey?: string; model?: string }
      | undefined
    const providerOverride = await getLlmProviderOverride(db, 'extraction').catch(() => null)
    const config = resolveLlmConfig(providerOverride ?? llmCfg, {
      maxTokens: await getLlmMaxTokens(db, insightId),
    })
    if (!config) {
      throw createError({ statusCode: 503, statusMessage: 'LLM not configured' })
    }

    const now = Date.now()
    const rateLimitKey = `${insightId}:${requestClientIp(event)}`
    const rateLimitOpts = { max: definition.rateLimitPerHourPerIp, windowMs: RATE_LIMIT_WINDOW_MS }
    if (!checkInMemoryRateLimit(insightRateLimit, rateLimitKey, now, rateLimitOpts)) {
      throw createError({ statusCode: 429, statusMessage: 'insight rate limit exceeded' })
    }
    recordInMemoryRateLimitHit(insightRateLimit, rateLimitKey, now, rateLimitOpts)

    const { systemPrompt, userText } = definition.buildPrompt(auction)
    const raw = await getProvider(config).extract({
      systemPrompt,
      schema: definition.schema,
      parts: [{ type: 'text', text: userText }],
    })
    const payload = definition.clamp(raw)
    if (payload == null) {
      throw createError({ statusCode: 502, statusMessage: 'LLM did not return a valid insight' })
    }
    await writeInsight(db, insightId, contentHash, payload)
    setResponseHeader(event, 'x-zvg-insight-cache', 'generated')
    return { payload, at: new Date().toISOString() }
  })()

  inflight.set(inflightKey, gen)
  try {
    return await gen
  } finally {
    inflight.delete(inflightKey)
  }
})
