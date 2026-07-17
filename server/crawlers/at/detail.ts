import { load } from 'cheerio'
import type { Auction, Attachment } from '~/types/auction'
import { AT_BASE, UA } from './constants'
import { parseEuroAt, parseSqmAt, stripHtml } from './text'
import { classifyAttachment } from '~/server/utils/classify-attachment'

export interface DetailInfo {
  aktenzeichen: string | null
  amtsgericht: string | null
  /** Court name + room (e.g. "Bezirksgericht Vöcklabruck, Saal Nr. 1") */
  versteigerungsOrt: string | null
  adresse: string | null
  schaetzwertEur: number | null
  schaetzwertText: string | null
  vadiumText: string | null
  geringstesGebotText: string | null
  /** "Objektgröße" mapped by Kategorie(n): Wohnung/Haus → living area. */
  sourceLivingAreaSqm: number | null
  /** "Grundstücksgröße", or "Objektgröße" when the Kategorie is a plot type. */
  sourceLandAreaSqm: number | null
  beschreibung: string | null
  attachments: Attachment[]
  pdfUrl: string | null
  pdfUrlUpstream: string | null
  fotoCount: number
  thumbnailUrl: string | null
}

const FETCH_TIMEOUT_MS = 20_000

async function fetchDetailHtml(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-AT,de;q=0.9',
      },
    })
    if (!res.ok) throw new Error(`AT detail HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pulls label/value pairs from a Bootstrap-style detail page. Each row is
 *   <span class="col-sm-3 ...">Label:</span><p class="col-sm-9">Value</p>
 * The label is the only stable handle — class names rotate between rows.
 */
function extractLabelPairs($: ReturnType<typeof load>): Map<string, string> {
  const pairs = new Map<string, string>()
  $('span.col-sm-3').each((_i, el) => {
    const $label = $(el)
    const rawLabel = $label.text().replace(/[:\s]+$/, '').trim()
    if (!rawLabel) return
    const $value = $label.next('p.col-sm-9, p')
    if ($value.length === 0) return
    const html = $value.html() ?? ''
    const value = stripHtml(html)
    if (value) pairs.set(rawLabel.toLowerCase(), value)
  })
  return pairs
}


interface ExtractedAttachments {
  attachments: Attachment[]
  thumbnailUrl: string | null
}

/**
 * Extracts file uploads from the dedicated "Uploads" block in the detail
 * page. The block is bounded by two HTML comments:
 *
 *   <!-- Uploads -->
 *   ... rows of <div class="row"> with <strong>Label:</strong> + anchors ...
 *   <!-- Weiter Edikte zum Fall -->
 *
 * Anchors outside this slice are cross-references to other Edikte in the
 * same case and must NOT be returned as attachments. Within the slice, the
 * section-row label (e.g. "Langgutachten:", "Foto(s):") drives the
 * attachment kind — that is more reliable than the anchor text.
 */
function buildAttachments(html: string): ExtractedAttachments {
  const start = html.indexOf('<!-- Uploads -->')
  if (start === -1) return { attachments: [], thumbnailUrl: null }
  // End at the next major comment-delimited section, or at the footer if
  // none follow. Either of the two known boundaries works as the closing
  // marker.
  const endMarkers = ['<!-- Weiter Edikte zum Fall -->', '<!-- Footer-->', '<footer']
  let end = html.length
  for (const m of endMarkers) {
    const idx = html.indexOf(m, start)
    if (idx !== -1 && idx < end) end = idx
  }
  const block = html.slice(start, end)
  const $ = load(block, null, false)
  const out: Attachment[] = []
  let thumbnailUrl: string | null = null

  $('div.row').each((_i, row) => {
    const $row = $(row)
    const sectionLabelRaw = $row.find('span.col-sm-3 strong').first().text()
    const sectionLabel = sectionLabelRaw.replace(/[:\s]+$/, '').trim()
    if (!sectionLabel) return
    $row.find('a[href*="exedi3.nsf"]').each((_j, a) => {
      const $a = $(a)
      const hrefRaw = $a.attr('href') ?? ''
      if (!/exedi3\.nsf\/0\//.test(hrefRaw)) return
      const href = hrefRaw.startsWith('http') ? hrefRaw : `${AT_BASE}${hrefRaw}`
      const linkLabel = ($a.attr('title') ?? $a.text()).replace(/\s+/g, ' ').trim()
      if (!linkLabel) return
      const filename = href.split('/').pop()?.split('?')[0] || linkLabel
      const sizeMatch = linkLabel.match(/\((\d+)\s*KB\)/i)
      const sizeBytes = sizeMatch?.[1] ? parseInt(sizeMatch[1], 10) * 1024 : null
      const fileIdMatch = hrefRaw.match(/\/0\/([a-f0-9]+)/i)
      const fileId = fileIdMatch?.[1] ?? href
      const kind = classifyAttachment(sectionLabel)
      out.push({
        kind,
        label: linkLabel
          .replace(/\s*\(neues Fenster\)/i, '')
          .replace(/\s*\(\d+\s*KB\)\s*$/i, '')
          .trim() || sectionLabel,
        filename,
        sizeBytes,
        fileId,
        proxyUrl: href,
      })

      // Foto rows wrap each thumbnail in <a><img src="…th1…jpg"/></a>. Grab
      // the first one we see as the auction's thumbnail.
      if (kind === 'foto' && thumbnailUrl == null) {
        const thumbSrcRaw = $a.find('img').attr('src') ?? ''
        if (thumbSrcRaw) {
          thumbnailUrl = thumbSrcRaw.startsWith('http') ? thumbSrcRaw : `${AT_BASE}${thumbSrcRaw}`
        }
      }
    })
  })

  const seen = new Set<string>()
  const attachments = out.filter((a) => {
    const key = `${a.fileId}|${a.kind}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { attachments, thumbnailUrl }
}

/** "BG Vöcklabruck, 503 8 E 8/25h" → court "BG Vöcklabruck", AZ "503 8 E 8/25h". */
function parseTitle2(title: string): { amtsgericht: string | null; aktenzeichen: string | null } {
  const m = title.match(/^([^,]+?),\s*(.+)$/)
  if (!m || !m[1] || !m[2]) return { amtsgericht: null, aktenzeichen: null }
  return { amtsgericht: m[1].trim(), aktenzeichen: m[2].trim() }
}

/** Kategorie(n) values that make "Objektgröße" a living area (Wohnung/Haus). */
const LIVING_KATEGORIE_RE = /wohnung|haus|villa/i
/** Kategorie(n) values that make "Objektgröße" a plot area. */
const LAND_KATEGORIE_RE = /grundstück|grund\b|wald|acker|wiese|feld|weingarten|landwirtschaft/i

export async function fetchDetail(detailUrl: string): Promise<DetailInfo> {
  return parseDetail(await fetchDetailHtml(detailUrl))
}

/** Pure HTML → DetailInfo mapping — exported for tests. */
export function parseDetail(html: string): DetailInfo {
  const $ = load(html)
  const pairs = extractLabelPairs($)

  // Title bar carries the canonical "<court>, <aktenzeichen>" pair.
  const title2 = $('#title2').text().trim()
  const fromTitle = parseTitle2(title2)

  // Aktenzeichen exists as a labeled row too, but it lacks the court prefix.
  // We keep both so callers can pick the more verbose one.
  const aktenzeichenRow = pairs.get('aktenzeichen') ?? null
  const aktenzeichen = fromTitle.aktenzeichen ?? aktenzeichenRow

  const amtsgericht = fromTitle.amtsgericht ?? pairs.get('dienststelle') ?? null

  const versteigerungsOrt = pairs.get('versteigerungsort') ?? pairs.get('verhandlungsort') ?? null
  const liegenschaft = pairs.get('liegenschaftsadresse') ?? null
  const plzOrt = pairs.get('plz/ort') ?? null
  const adresse = [liegenschaft, plzOrt].filter(Boolean).join(', ') || null

  const schaetzwertText = pairs.get('schätzwert') ?? pairs.get('schaetzwert') ?? null
  const schaetzwertEur = parseEuroAt(schaetzwertText)
  const vadiumText = pairs.get('vadium') ?? null
  const geringstesGebotText = pairs.get('geringstes gebot') ?? null

  const kategorie = pairs.get('kategorie(n)') ?? pairs.get('kategorie') ?? null
  const objektgroesseText = pairs.get('objektgröße') ?? null
  const grundstuecksgroesseText = pairs.get('grundstücksgröße') ?? null

  // "Objektgröße" is the building/unit size for Wohnung/Haus categories but
  // the plot size for Grundstück-type categories. Ambiguous or unknown
  // categories keep the value as labeled text in the beschreibung only.
  const isLiving = kategorie != null && LIVING_KATEGORIE_RE.test(kategorie)
  const isLand = kategorie != null && LAND_KATEGORIE_RE.test(kategorie)
  const objektgroesseSqm = parseSqmAt(objektgroesseText)
  const sourceLivingAreaSqm = isLiving && !isLand ? objektgroesseSqm : null
  const sourceLandAreaSqm =
    parseSqmAt(grundstuecksgroesseText) ?? (isLand && !isLiving ? objektgroesseSqm : null)

  const grundbuch = pairs.get('grundbuch') ?? null
  const ez = pairs.get('ez') ?? null

  // Compose a description from the most informative free-text rows, followed
  // by a compact "Label: Wert" block with the structured rows the parser
  // would otherwise drop (feeds display + extraction).
  const descParts = [
    pairs.get('beschreibung (we)'),
    pairs.get('beschreibung'),
    pairs.get('sonstige hinweise'),
  ].filter((s): s is string => Boolean(s))
  const infoLines = [
    kategorie && `Kategorie: ${kategorie}`,
    objektgroesseText && `Objektgröße: ${objektgroesseText}`,
    grundstuecksgroesseText && `Grundstücksgröße: ${grundstuecksgroesseText}`,
    versteigerungsOrt && `Versteigerungsort: ${versteigerungsOrt}`,
    vadiumText && `Vadium: ${vadiumText}`,
    geringstesGebotText && `Geringstes Gebot: ${geringstesGebotText}`,
    // Grundbuch/EZ only when they are the usual short "12345 Ort" / number
    // forms — some Edikte stuff whole paragraphs into these rows.
    grundbuch &&
      grundbuch.length <= 60 &&
      `Grundbuch: ${grundbuch}${ez && ez.length <= 20 ? `, EZ ${ez}` : ''}`,
  ].filter((s): s is string => Boolean(s))
  const beschreibung = [...descParts, infoLines.join('\n')].filter(Boolean).join('\n\n') || null

  const { attachments, thumbnailUrl: explicitThumb } = buildAttachments(html)
  // Headline PDF: prefer the official notice (matches zvbawü's `bulletin`
  // and BOE's boletín document), then the Gutachten — which on AT is the
  // most informative file when no separate bekanntmachung PDF exists.
  // Falling back to "any PDF" last keeps the field non-null when an
  // Exposé-only Edikt shows up.
  const isPdf = (a: Attachment): boolean => /\.pdf(?:[?#]|$)/i.test(a.proxyUrl)
  const headlinePdf =
    attachments.find((a) => a.kind === 'bekanntmachung' && isPdf(a)) ??
    attachments.find((a) => a.kind === 'gutachten' && isPdf(a)) ??
    attachments.find(isPdf)
  const firstPhoto = attachments.find((a) => a.kind === 'foto')
  const photos = attachments.filter((a) => a.kind === 'foto')

  return {
    aktenzeichen: aktenzeichen ?? null,
    amtsgericht: amtsgericht ?? null,
    versteigerungsOrt,
    adresse,
    schaetzwertEur,
    schaetzwertText,
    vadiumText,
    geringstesGebotText,
    sourceLivingAreaSqm,
    sourceLandAreaSqm,
    beschreibung,
    attachments,
    pdfUrl: headlinePdf?.proxyUrl ?? null,
    pdfUrlUpstream: headlinePdf?.proxyUrl ?? null,
    fotoCount: photos.length,
    // Prefer the inline thumbnail (~55x80px) over the full-size photo URL;
    // both lead to the same image, but the thumbnail saves bandwidth in the
    // map/list views.
    thumbnailUrl: explicitThumb ?? firstPhoto?.proxyUrl ?? null,
  }
}

export async function enrichInBatches(
  auctions: Auction[],
  apply: (auction: Auction, info: DetailInfo) => void,
  concurrency = 6,
): Promise<{ enriched: number; errors: number }> {
  let cursor = 0
  let enriched = 0
  let errors = 0
  async function worker(): Promise<void> {
    while (cursor < auctions.length) {
      const idx = cursor++
      const item = auctions[idx]
      if (!item) continue
      if (!item.detailUrlUpstream) continue
      try {
        const info = await fetchDetail(item.detailUrlUpstream)
        apply(item, info)
        enriched++
      } catch (err) {
        console.debug(
          `[at] detail enrichment failed for ${item.zvgId}: ${(err as Error).message}`,
        )
        errors++
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return { enriched, errors }
}
