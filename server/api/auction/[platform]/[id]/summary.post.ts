// Lazy German AI summary for one auction. Checks the disk cache first;
// generates via LLM only on first call. Safe to retry: repeated POSTs return
// the cached text instantly without a new LLM call.
//
// The summary is separate from the field-extraction pipeline (propertyType,
// areas, rooms). It produces a human-readable German overview regardless of the
// source language (CZ/PL/IT/BE content is translated on the fly).

import { readAuctionSnapshot } from '../../../../utils/auction-snapshot'
import { readSummaryCache, writeSummaryCache } from '../../../../utils/summary-cache'
import { isSafePathSegment } from '../../../../utils/path-segment'
import { cacheKey } from '../../../../utils/verkehrswert-cache'
import { pickBestPdf, pdfToText } from '../../../../utils/extract/pdf-text'

const MAX_PDF_CHARS = 8_000

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
  if (a.objekt) lines.push(`Objektbezeichnung: ${a.objekt}`)
  if (a.adresse) lines.push(`Adresse: ${a.adresse}`)
  if (a.amtsgericht) lines.push(`Amtsgericht: ${a.amtsgericht}`)
  if (a.aktenzeichen) lines.push(`Aktenzeichen: ${a.aktenzeichen}`)
  if (a.verkehrswertText) {
    lines.push(`Verkehrswert: ${a.verkehrswertText}`)
  } else if (typeof a.verkehrswertEur === 'number') {
    lines.push(`Verkehrswert: ${(a.verkehrswertEur as number).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })}`)
  }
  if (a.terminText) lines.push(`Termin: ${a.terminText}`)
  const ext = a.extraction as Record<string, unknown> | undefined
  if (ext?.landAreaSqm != null) lines.push(`Grundstücksfläche: ${ext.landAreaSqm} m²`)
  if (ext?.livingAreaSqm != null) lines.push(`Wohnfläche: ${ext.livingAreaSqm} m²`)
  if (ext?.rooms != null) lines.push(`Zimmer: ${ext.rooms}`)
  if (ext?.units != null) lines.push(`Wohneinheiten: ${ext.units}`)
  if (a.beschreibung) lines.push(`\nBeschreibung:\n${a.beschreibung}`)
  return lines.join('\n')
}

async function callLlm(
  userPrompt: string,
  pdfText: string | null,
  config: { baseUrl: string; model: string },
): Promise<string | null> {
  const content = pdfText
    ? `${userPrompt}\n\nAuszug aus Gutachten/Exposé:\n${pdfText.slice(0, MAX_PDF_CHARS)}`
    : userPrompt
  let resp: unknown
  try {
    resp = await $fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: {
        model: config.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      },
      signal: AbortSignal.timeout(120_000),
    })
  } catch (err) {
    console.warn(`[summary] LLM request failed: ${(err as Error).message}`)
    return null
  }
  if (!resp || typeof resp !== 'object') return null
  const blocks = (resp as { content?: unknown }).content
  if (!Array.isArray(blocks)) return null
  const text = blocks.find(
    (b: unknown) => b && typeof b === 'object' && (b as { type?: string }).type === 'text',
  )
  return text ? ((text as { text: string }).text ?? '').trim() : null
}

export default defineEventHandler(async (event) => {
  const platform = String(event.context.params?.platform ?? '')
  const id = String(event.context.params?.id ?? '')
  if (!isSafePathSegment(platform) || !isSafePathSegment(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id' })
  }

  const llmCfg = useRuntimeConfig().extractLlm as { baseUrl?: string; model?: string } | undefined
  if (!llmCfg?.baseUrl) {
    throw createError({ statusCode: 503, statusMessage: 'LLM not configured' })
  }
  const config = { baseUrl: llmCfg.baseUrl, model: llmCfg.model || 'claude-haiku-4-5' }

  const key = cacheKey(platform, id)

  // Return cached summary immediately without touching the LLM.
  const cache = await readSummaryCache()
  if (cache[key]) {
    return { summary: cache[key]!.text }
  }

  const snapshot = await readAuctionSnapshot()
  const auction = snapshot[key]
  if (!auction) {
    throw createError({ statusCode: 404, statusMessage: 'auction not found' })
  }

  const bestPdf = pickBestPdf(auction.attachments ?? [])
  const pdfText = bestPdf ? await pdfToText(bestPdf.proxyUrl) : null

  const summary = await callLlm(buildPrompt(auction as unknown as Record<string, unknown>), pdfText, config)
  if (!summary) {
    throw createError({ statusCode: 502, statusMessage: 'LLM did not return a summary' })
  }

  cache[key] = { text: summary, at: new Date().toISOString() }
  await writeSummaryCache(cache)

  return { summary }
})
