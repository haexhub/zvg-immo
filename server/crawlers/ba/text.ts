import { BAM_PER_EUR } from './constants'

/** "21.08.2026" → "2026-08-21" */
export function parseBaDate(raw: string): string | null {
  const m = raw.match(/(\d{2})\.(\d{2})\.(\d{4})/)
  if (!m) return null
  return `${m[3]}-${m[2]}-${m[1]}`
}

function parseBamNum(raw: string): number | null {
  let s = raw.trim()
  // European format "150.000,00" → comma is decimal, dots are thousands
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.')
  } else {
    // No comma: dots are thousands separators ("150.000")
    s = s.replace(/\./g, '')
  }
  const n = parseFloat(s)
  // Ignore implausibly small amounts (court fees etc.)
  return Number.isFinite(n) && n >= 1000 ? n : null
}

/** Find a BAM price in a text block, return { eur, text } or null */
export function parseBamPrice(text: string): { eur: number; text: string } | null {
  // Prefer an amount that follows a price/value label (lazy gap so k/m in words don't block match)
  const labeled = text.match(/(?:cijena|vrijednost)[^\n]{0,80}?([\d.,]+)\s*KM/i)
  let bam: number | null = labeled?.[1] ? parseBamNum(labeled[1]) : null

  // Fall back to the first KM amount that is ≥ 1000
  if (bam === null) {
    for (const m of text.matchAll(/([\d.,]+)\s*KM/gi)) {
      const n = parseBamNum(m[1]!)
      if (n !== null) { bam = n; break }
    }
  }

  if (bam === null) return null
  return {
    eur: Math.round(bam / BAM_PER_EUR),
    text: `${bam.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} KM`,
  }
}

/** Try to find an address/location hint in body text */
export function extractLocation(text: string): string | null {
  // Cadastral municipality: "KO Sarajevo-Centar", "KO Banja Luka"
  const ko = text.match(/\bKO\s+([A-ZČĆŠŽĐ][a-zA-ZčćšžđČĆŠŽĐ \-]{1,30})/u)
  if (ko) return ko[1]!.replace(/\s+/g, ' ').trim() + ', Bosnien-Herzegowina'

  // Street address: "ul. Ferhadija 12" / "Ulica Maršala Tita"
  const ul = text.match(/[Uu]l(?:ica|\.)\.?\s+([A-ZČĆŠŽĐ][^\n,]{3,50})/u)
  if (ul) return ul[1]!.replace(/\s+/g, ' ').trim() + ', Bosnien-Herzegowina'

  // Municipality: "općina/opština [Name]"
  const op = text.match(/op[cć]in[ae]\s+([A-ZČĆŠŽĐ][a-zA-ZčćšžđČĆŠŽĐ ]{2,30})/iu)
  if (op) return op[1]!.replace(/\s+/g, ' ').trim() + ', Bosnien-Herzegowina'

  return null
}

/** Strip HTML tags and normalize whitespace, preserving line breaks */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n +/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
