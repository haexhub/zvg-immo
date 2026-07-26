import { findRooms, parseAreaValue } from '~/server/utils/extract/sizes'

/**
 * Extract the text content of the `<p class="normal">` that immediately follows
 * the `<h3 id="h-{fieldId}">` sidebar fact block or the `<h2 id="h-{fieldId}">`
 * body fact block (Tomtbeskrivning, Fastighetsbeteckning, Upplåtelseform, …).
 */
export function extractFact(html: string, fieldId: string): string | null {
  const re = new RegExp(
    `id="h-${fieldId}"[^>]*>[^<]+</h[23]>\\s*<p[^>]*>([^<]+)`,
    'i',
  )
  const m = html.match(re)
  if (!m || !m[1]) return null
  return m[1].replace(/&nbsp;/g, ' ').trim() || null
}

/** "6 rum, 175 kvm" → { rooms: 6, livingAreaSqm: 175 }; either part may be missing. */
export function parseStorlek(raw: string | null): { rooms: number | null; livingAreaSqm: number | null } {
  if (!raw) return { rooms: null, livingAreaSqm: null }
  // Delegate to the central extractors: findRooms knows "rum" (incl. "4,5 rum"),
  // parseAreaValue knows "kvm" and the Swedish space-grouped thousands.
  const rooms = findRooms(raw)
  const area = parseAreaValue(raw)
  return {
    rooms: rooms != null && rooms > 0 ? rooms : null,
    livingAreaSqm: area != null && area > 0 ? area : null,
  }
}

/** "Småhusenhet, bebyggd (220)." → "Småhusenhet, bebyggd" */
export function cleanCategory(raw: string | null): string | null {
  if (!raw) return null
  const text = raw.replace(/\s*\(\d+\)\s*\.?$/, '').replace(/\.$/, '').trim()
  return text || null
}

/** "600000:-" or "1 200 000:-" → 600000 (SEK, integer) */
export function parseSekAmount(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, '')
  const n = parseInt(digits, 10)
  return Number.isFinite(n) && n >= 1000 ? n : null
}

export function cleanKronofogdenAddress(raw: string): string {
  return raw
    .replace(/\badress\s+saknas\s*\/\s*/gi, '')
    .replace(/\badress\s+saknas\b/gi, '')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,\s*(\d{3})\s?(\d{2})\s*,\s*/g, ', $1 $2 ')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*$/g, '')
    .trim()
}

export function extractShowingAddress(html: string): string | null {
  const matches = html.matchAll(/"showingAddress"\s*:\s*"((?:\\.|[^"\\])*)"/g)
  for (const match of matches) {
    const raw = match[1]
    if (!raw) continue
    try {
      const decoded = JSON.parse(`"${raw}"`) as unknown
      if (typeof decoded !== 'string') continue
      const cleaned = cleanKronofogdenAddress(decoded)
      if (cleaned) return cleaned
    } catch {
      // Ignore malformed embedded state and keep looking.
    }
  }
  return null
}

/** Strips HTML tags and normalises whitespace, preserving paragraph breaks. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n +/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Extract the main listing body text (intro + content sections).
 * Returns null if nothing meaningful is found.
 */
export function extractBody(html: string): string | null {
  // Grab the Mittenspalt (centre column) which holds description + facts
  const mid = html.match(/<div[^>]+id="Mittenspalt"[^>]*>[\s\S]*?(?=<div[^>]+id="(?:Hogerspalt|svid10_6294450154af3d2b[^"]+|Footer)")/i)?.[0] ?? null
  if (!mid) return null
  const text = stripHtml(mid)
  return text.length > 20 ? text.slice(0, 3000) : null
}
