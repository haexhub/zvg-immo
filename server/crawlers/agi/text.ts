import { parseLocaleNumber } from '~/server/utils/extract/sizes'

/** Clean up the portal's tipologia string.
 *  E.g. "IMMOBILI-IMMOBILE RESIDENZIALE" → "Immobile residenziale". */
export function cleanTipologia(raw: string | null | undefined): string | null {
  if (!raw) return null
  const suffix = raw.includes('-') ? raw.split('-').slice(1).join('-') : raw
  return suffix
    .trim()
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase())
}

/** Pick the best available auction date from the detail response. */
export function pickTerminIso(
  dataVendita: string | null,
  dataFineGara: string | null,
  dataUdienza: string | null,
): string | null {
  return dataVendita ?? dataFineGara ?? dataUdienza ?? null
}

/** Format a decimal EUR amount as German-style text, e.g. "54.000,00 €". */
export function formatEur(amount: number | null): string | null {
  if (amount == null) return null
  return (
    amount.toLocaleString('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + ' €'
  )
}

/** Format an ISO date string as German-style text, e.g. "22.10.2026 11:00 Uhr". */
export function formatTerminText(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const date = d.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  return `${date} ${time} Uhr`
}

/** Parse an Italian-formatted decimal like "5.545,00" or "51,00" (also plain
 *  "5545,00"). Returns null for "-", empty or non-numeric input. Delegates the
 *  separator heuristics to the central parseLocaleNumber; the shape check
 *  keeps garbage cell values ("3+2") out. */
export function parseItNumber(raw: string | null | undefined): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!/^[\d.,\s ]+$/.test(trimmed)) return null
  const n = parseLocaleNumber(trimmed)
  return n != null && n > 0 ? n : null
}

/** Derive the `kind` of an allegato attachment from its filename prefix.
 *  Known prefixes: perizia, avviso, ordinanza, planimetria, foto, virtuale. */
export function allegatoKind(
  filename: string,
): 'bekanntmachung' | 'gutachten' | 'sonstiges' | 'foto' {
  const lower = filename.toLowerCase()
  if (lower.startsWith('avviso')) return 'bekanntmachung'
  if (lower.startsWith('perizia')) return 'gutachten'
  if (lower.startsWith('foto')) return 'foto'
  return 'sonstiges'
}
