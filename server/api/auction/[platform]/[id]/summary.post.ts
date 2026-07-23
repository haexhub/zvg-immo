// Lazy German AI summary for one auction. Checks the disk cache first;
// generates via LLM only on first call. Safe to retry: repeated POSTs return
// the cached text instantly without a new LLM call.
//
// The summary is separate from the field-extraction pipeline (propertyType,
// areas, rooms). It produces a human-readable German overview regardless of the
// source language (CZ/PL/IT/BE content is translated on the fly).

import type { H3Event } from 'h3'
import { readAuctionSnapshot } from '../../../../utils/auction-snapshot'
import { readSummaryCache, writeSummaryCache } from '../../../../utils/summary-cache'
import { isSafePathSegment } from '../../../../utils/path-segment'
import { cacheKey } from '../../../../utils/verkehrswert-cache'
import { pickBestPdf, pdfToText } from '../../../../utils/extract/pdf-text'
import { resolveLlmConfig } from '../../../../utils/extract/llm'
import { callSummaryLlm } from '../../../../utils/extract/text-llm'
import { getPool } from '../../../../utils/db'
import { DEFAULT_LLM_MAX_TOKENS, getLlmMaxTokens } from '../../../../utils/app-settings'
import {
  checkInMemoryRateLimit,
  createInMemoryRateLimitState,
  recordInMemoryRateLimitHit,
} from '../../../../utils/in-memory-rate-limit'

const MAX_PDF_CHARS = 8_000

// In-flight generations keyed by cache key: dedupes concurrent misses for the
// same auction (one LLM call, not N) and caps total concurrent LLM work so a
// burst of cache misses on distinct auctions can't fan out into unbounded paid
// requests. The endpoint is public and generates only for auctions that exist
// in the snapshot, so this in-process throttle is the proportionate guard.
const inflight = new Map<string, Promise<string>>()
const MAX_INFLIGHT = 4
const SUMMARY_RATE_LIMIT = { max: 20, windowMs: 60 * 60 * 1000, maxKeys: 10_000 }
const summaryRateLimit = createInMemoryRateLimitState()

const SYSTEM_PROMPT =
  'Du fasst Immobilien-Zwangsversteigerungen prägnant auf Deutsch zusammen. ' +
  'Gliedere deine Antwort mit diesen Markdown-Überschriften (lass Abschnitte ohne Inhalt weg):\n' +
  '**Objekt & Lage** — Objektart, Adresse, Lage in 1–2 Sätzen\n' +
  '**Eckdaten** — Wohn- und Grundstücksfläche, Zimmer, Wohneinheiten\n' +
  '**Versteigerung** — Termin, Amtsgericht, Aktenzeichen, Verkehrswert\n' +
  '**Beschreibung** — Zustand, Besonderheiten, relevante Details aus Gutachten/Exposé (3–5 Sätze)\n' +
  'Übersetze alle fremdsprachigen Inhalte vollständig ins Deutsche. ' +
  'Keine Werbephrasen oder Wertungen. Kein Hinweis darauf, dass du übersetzt hast.'

function buildPrompt(a: Record<string, unknown>): string {
  const lines: string[] = []
  if (a.title) lines.push(`Objektbezeichnung: ${a.title}`)
  if (a.address) lines.push(`Adresse: ${a.address}`)
  if (a.authority) lines.push(`Amtsgericht: ${a.authority}`)
  if (a.caseNumber) lines.push(`Aktenzeichen: ${a.caseNumber}`)
  if (a.marketValueText) {
    lines.push(`Verkehrswert: ${a.marketValueText}`)
  } else if (typeof a.marketValueEur === 'number') {
    lines.push(`Verkehrswert: ${(a.marketValueEur as number).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })}`)
  }
  if (a.auctionDateText) lines.push(`Termin: ${a.auctionDateText}`)
  const ext = a.extraction as Record<string, unknown> | undefined
  if (ext?.landAreaSqm != null) lines.push(`Grundstücksfläche: ${ext.landAreaSqm} m²`)
  if (ext?.livingAreaSqm != null) lines.push(`Wohnfläche: ${ext.livingAreaSqm} m²`)
  if (ext?.rooms != null) lines.push(`Zimmer: ${ext.rooms}`)
  if (ext?.units != null) lines.push(`Wohneinheiten: ${ext.units}`)
  if (a.description) lines.push(`\nBeschreibung:\n${a.description}`)
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

  const llmCfg = useRuntimeConfig().extractLlm as
    | { provider?: string; baseUrl?: string; apiKey?: string; model?: string }
    | undefined
  // Postgres is not a hard requirement here (only the disk-based summary
  // cache is) — degrade to the hard-coded default instead of a 503 so
  // summary generation doesn't suddenly depend on Postgres.
  const db = getPool()
  const maxTokens = db
    ? await getLlmMaxTokens(db, 'summary').catch(() => DEFAULT_LLM_MAX_TOKENS.summary)
    : DEFAULT_LLM_MAX_TOKENS.summary
  const config = resolveLlmConfig(llmCfg, { maxTokens })
  if (!config) {
    throw createError({ statusCode: 503, statusMessage: 'LLM not configured' })
  }

  const key = cacheKey(platform, id)

  // Return cached summary immediately without touching the LLM.
  const cache = await readSummaryCache()
  if (cache[key]) {
    return { summary: cache[key]!.text }
  }

  // Cache miss → generate. Reuse an in-flight generation for the same auction
  // instead of paying for a second LLM call.
  const existing = inflight.get(key)
  if (existing) {
    return { summary: await existing }
  }
  if (inflight.size >= MAX_INFLIGHT) {
    throw createError({ statusCode: 429, statusMessage: 'summary generation busy, retry shortly' })
  }

  const snapshot = await readAuctionSnapshot()
  const auction = snapshot[key]
  if (!auction) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }

  const now = Date.now()
  const requester = clientKey(event)
  if (!checkInMemoryRateLimit(summaryRateLimit, requester, now, SUMMARY_RATE_LIMIT)) {
    throw createError({ statusCode: 429, statusMessage: 'summary generation rate limit exceeded' })
  }
  recordInMemoryRateLimitHit(summaryRateLimit, requester, now, SUMMARY_RATE_LIMIT)

  const gen = (async () => {
    const bestPdf = pickBestPdf(auction.attachments ?? [])
    const pdfText = bestPdf
      ? await pdfToText(bestPdf.proxyUrl, {
          identity: {
            platform: auction.platform,
            country: auction.country,
            externalId: auction.externalId,
            caseNumber: auction.caseNumber,
            authority: auction.authority,
          },
          capturedAt: new Date().toISOString(),
        })
      : null

    const prompt = buildPrompt(auction as unknown as Record<string, unknown>)
    const content = pdfText
      ? `${prompt}\n\nAuszug aus Gutachten/Exposé:\n${pdfText.slice(0, MAX_PDF_CHARS)}`
      : prompt
    const summary = await callSummaryLlm(SYSTEM_PROMPT, content, config)
    if (!summary) {
      throw createError({ statusCode: 502, statusMessage: 'LLM did not return a summary' })
    }

    // Re-read before writing so a concurrent generation for a *different*
    // auction isn't clobbered by our stale snapshot.
    const latest = await readSummaryCache()
    latest[key] = { text: summary, at: new Date().toISOString() }
    await writeSummaryCache(latest)
    return summary
  })()

  inflight.set(key, gen)
  try {
    return { summary: await gen }
  } finally {
    inflight.delete(key)
  }
})
