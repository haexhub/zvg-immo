import { load } from 'cheerio'
import type { Auction, Attachment, AttachmentKind } from '~/types/auction'
import { AT_BASE, UA } from './constants'
import { parseEuroAt, stripHtml } from './text'

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

/**
 * Section-label → AttachmentKind. Plans (Grundriss, Lageplan) stay as
 * 'sonstiges' even though they happen to ship as JPEGs: fotoCount and
 * thumbnailUrl downstream are meant for actual property photographs, not
 * floor-plan drawings. The Attachment is still preserved in the array — it
 * just doesn't claim photo semantics it doesn't have.
 */
const KIND_BY_SECTION_LABEL: ReadonlyArray<[RegExp, AttachmentKind]> = [
  [/edikt|bekanntmachung|verlautbarung/i, 'bekanntmachung'],
  [/gutachten/i, 'gutachten'],
  [/expos[ée]/i, 'exposee'],
  [/foto|bild/i, 'foto'],
]

function classifyBySection(sectionLabel: string): AttachmentKind {
  for (const [re, kind] of KIND_BY_SECTION_LABEL) {
    if (re.test(sectionLabel)) return kind
  }
  return 'sonstiges'
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
      const kind = classifyBySection(sectionLabel)
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

export async function fetchDetail(detailUrl: string): Promise<DetailInfo> {
  const html = await fetchDetailHtml(detailUrl)
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

  // Compose a description from the most informative free-text rows.
  const descParts = [
    pairs.get('beschreibung (we)'),
    pairs.get('beschreibung'),
    pairs.get('sonstige hinweise'),
  ].filter((s): s is string => Boolean(s))
  const beschreibung = descParts.join('\n\n') || null

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
