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
  // Prefer an amount that follows a price/value label. Stem matching covers the
  // inflected variants ("procijenjena/utvrđena/početna/tržišna vrijednost",
  // "cijene", "vrijednosti", …); the gap may span line breaks (court documents
  // wrap mid-sentence). Amounts < 1000 KM (court fees, deposits) are skipped
  // via parseBamNum, moving on to the next labeled amount.
  let bam: number | null = null
  for (const m of text.matchAll(/(?:cijen|vrijednost)[\s\S]{0,160}?([\d.,]+)\s*KM/gi)) {
    // "ne može iznositi više od / najviše 10.000,00 KM" is a deposit cap, not a value
    if (/vi[sš]e\s+od|najvi[sš]e/i.test(m[0]!)) continue
    const n = parseBamNum(m[1]!)
    if (n !== null) { bam = n; break }
  }

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
  const found = (s: string) => s.replace(/\s+/g, ' ').trim() + ', Bosnien-Herzegowina'

  // Cadastral municipality: "KO Sarajevo-Centar", "k.o. Ugljevik", "k.o . Čipuljić",
  // "katastarska općina Banjica". Name = 1-3 capitalized words; a leading "SP "/"SP_"
  // (stara premjera) is dropped. Lookbehind keeps "(BRČ)KO" from matching, and the
  // Brčko boilerplate "KO DISTRIKT BOSNE I HERCEGOVINE" is skipped — it is not a place.
  const koRe = /(?:katastarsk[ae] op[ćcš]tin[aeiu]|[Kk]\.\s?[Oo]\s?\.|(?<!\p{L})KO)\s+(?:SP[ _])?([A-ZČĆŠŽĐ][\p{L}]*(?:[ -][A-ZČĆŠŽĐ][\p{L}]*){0,2})/gu
  for (const m of text.matchAll(koRe)) {
    if (!/^DISTRIKT/i.test(m[1]!)) return found(m[1]!)
  }

  // Street address: "ul. Ferhadija 12" / "Ulica Maršala Tita"
  const ul = text.match(/[Uu]l(?:ica|\.)\.?\s+([A-ZČĆŠŽĐ][^\n,]{3,50})/u)
  if (ul) return found(ul[1]!)

  // Municipality/city: "općina/opština/grad [Name]" (no /i flag — the capture
  // must stay uppercase-anchored, otherwise it grabs lowercase non-places)
  const op = text.match(/(?:\b[Oo]p[cć]in[aeiu]|\b[Oo]p[sš]tin[aeiu]|\b[Gg]rad[aeu]?)\s+([A-ZČĆŠŽĐ][\p{L}]*(?:[ -][A-ZČĆŠŽĐ][\p{L}]*){0,2})/u)
  if (op) return found(op[1]!)

  // Postal code + place: "75300 Lukavac" (BiH postal codes are 7xxxx/8xxxx)
  const plz = text.match(/\b([78]\d{4})\s+([A-ZČĆŠŽĐ][\p{L}]+(?:[ -][A-ZČĆŠŽĐ][\p{L}]*){0,2})/u)
  if (plz) return found(`${plz[1]} ${plz[2]}`)

  // Debtor's place: "izvršenika Tomić Duška iz Kojčinovca"
  const iz = text.match(/izvr[sš]enik[au]?\s[\s\S]{0,80}?\biz\s+([A-ZČĆŠŽĐ][\p{L}]{2,25})/u)
  if (iz) return found(iz[1]!)

  // Court seat as last resort: "u Općinskom sudu u Lukavcu", "sud u Lukavcu"
  const sud = text.match(/[Ss]ud[au]?\s+[Uu]\s+([A-ZČĆŠŽĐ][\p{L}]{2,25})/u)
  if (sud) return found(sud[1]!)

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
