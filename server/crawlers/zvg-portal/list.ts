import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { ZVG_BASE, DE_REGION_NAMES, COUNTRY } from './constants'
import { clean, parseEuro, parseGermanDateTime, parseGermanTimestamp } from './text'

export interface ParseResult {
  totalReported: number | null
  auctions: Auction[]
}

export function parseAuctionsHtml(html: string, landAbk: string, platformId: string): ParseResult {
  const totalMatch = html.match(/Insgesamt\s+(\d+)/)
  const totalReported = totalMatch ? parseInt(totalMatch[1], 10) : null

  // Each entry block is delimited by the comment markers + a final <hr>.
  // Strategy: split the raw HTML at "<!--Aktenzeichen--->" and parse each chunk.
  const chunks = html.split('<!--Aktenzeichen--->').slice(1)
  const auctions: Auction[] = []

  for (const rawChunk of chunks) {
    const endMarker = rawChunk.indexOf('<!--Zwangsversteigerungen Ende-->')
    const chunk = endMarker >= 0 ? rawChunk.slice(0, endMarker) : rawChunk
    const $$ = load(`<table>${chunk}</table>`)

    // Termin first — we need to know if it's aufgehoben before deciding on ID strategy.
    let terminText: string | null = null
    let terminIso: string | null = null
    let aufgehoben = false
    const terminMatch = chunk.match(/<TR>\s*<TD[^>]*>\s*Termin\s*<\/[Tt][Dd]>([\s\S]*?)<\/[Tt][Rr]>/i)
    if (terminMatch) {
      const inner = terminMatch[1].replace(/<[^>]+>/g, ' ')
      const decoded = clean(inner)
      aufgehoben = /aufgehoben/i.test(decoded)
      terminText = decoded || null
      terminIso = parseGermanDateTime(decoded)
    }

    // ID extraction
    const aktenzeichenA = $$('a[href*="showZvg"]').first()
    const detailHref = aktenzeichenA.attr('href') || ''
    const zvgIdMatch = (chunk.match(/zvg_id=(\d+)/) || [])[1] || null

    let aktenzeichen = ''
    if (aktenzeichenA.length) {
      aktenzeichen = aktenzeichenA.text().replace(/\(Detailansicht\)/i, '').trim()
    } else {
      const azMatch = chunk.match(/<nobr>\s*(\d+\s+K\s+\d+\/\d+)\s*(?:&nbsp;)?\s*(?:\(Detailansicht\))?\s*<\/nobr>/i)
      if (azMatch) aktenzeichen = azMatch[1].trim()
    }
    aktenzeichen = clean(aktenzeichen)
    if (!aktenzeichen && !zvgIdMatch) continue

    const zvgId = zvgIdMatch || `az:${aktenzeichen}`

    const updateMatch = chunk.match(/letzte Aktualisierung\s+([\d-]+\s+[\d:]+)/)
    const letzteAktualisierungIso = updateMatch ? parseGermanTimestamp(updateMatch[1]) : null

    let amtsgericht = ''
    // Region name comes from landAbk (canonical), not from the HTML.
    // Upstream is inconsistent — e.g. BW renders as "Baden-Wuerttemberg" without
    // umlaut. landAbk is what we asked for and DE_REGION_NAMES is canonical.
    const regionName = DE_REGION_NAMES[landAbk] || landAbk
    // Capture only the first <b>…</b> after the Amtsgericht marker, with no
    // nested tags ([^<]+). A previous greedy variant matched across the entire
    // chunk and bled into later <b> blocks (Verkehrswert/Termin) when their
    // text contained " in " (e.g. "Sicherheitsleistung in Höhe …").
    // The captured text has the form "<court> in <bundesland>"; courts can
    // themselves contain " in " (e.g. "Landau in der Pfalz"), so split on the
    // LAST occurrence.
    const amtMatch = chunk.match(/<!--Amtsgericht--->[\s\S]*?<b>\s*([^<]+?)\s*<\/b>/i)
    if (amtMatch) {
      const inner = clean(amtMatch[1])
      const sep = inner.lastIndexOf(' in ')
      amtsgericht = sep >= 0 ? inner.slice(0, sep) : inner
    }

    let objekt: string | null = null
    let adresse: string | null = null
    const lageMatch = chunk.match(/<b>([^<]+?)<!--Lage--->\s*:?\s*<\/b>\s*([^<\n]+)/)
    if (lageMatch) {
      objekt = clean(lageMatch[1])
      adresse = clean(lageMatch[2])
    }

    let verkehrswertEur: number | null = null
    let verkehrswertText: string | null = null
    const vwMatch = chunk.match(/Verkehrswert in[\s\S]*?<b>([\s\S]*?)<\/b>/)
    if (vwMatch) {
      const inner = vwMatch[1].replace(/<[^>]+>/g, ' ')
      verkehrswertText = clean(inner) || null
      verkehrswertEur = parseEuro(inner)
    }

    let pdfUrl: string | null = null
    let pdfUrlUpstream: string | null = null
    const pdfMatch = chunk.match(/href="([^"]*showAnhang[^"]*)"/i)
    if (pdfMatch) {
      const raw = pdfMatch[1].trim().replace(/\s+$/, '')
      pdfUrlUpstream = `${ZVG_BASE}/${raw.replace(/^\/+/, '')}`
      const fileIdMatch = raw.match(/file_id=(\d+)/)
      if (fileIdMatch && zvgIdMatch) {
        pdfUrl = `/api/zvg-proxy?button=showAnhang&land_abk=${landAbk}&file_id=${fileIdMatch[1]}&zvg_id=${zvgIdMatch}`
      }
    }

    const detailUrlUpstream = detailHref
      ? `${ZVG_BASE}/${detailHref.replace(/^\/+/, '')}`
      : zvgIdMatch
        ? `${ZVG_BASE}/index.php?button=showZvg&zvg_id=${zvgIdMatch}&land_abk=${landAbk}`
        : `${ZVG_BASE}/index.php?button=Termine+suchen`

    const detailUrl = zvgIdMatch
      ? `/api/zvg-proxy?button=showZvg&zvg_id=${zvgIdMatch}&land_abk=${landAbk}`
      : detailUrlUpstream

    auctions.push({
      platform: platformId,
      country: COUNTRY,
      region: regionName,
      zvgId,
      aktenzeichen,
      amtsgericht,
      objekt,
      adresse,
      verkehrswertEur,
      verkehrswertText,
      terminIso,
      terminText,
      aufgehoben,
      letzteAktualisierungIso,
      pdfUrl,
      detailUrl,
      pdfUrlUpstream,
      detailUrlUpstream,
      attachments: [],
      beschreibung: null,
      fotoCount: 0,
      thumbnailUrl: null,
    })
  }

  // Deduplicate by zvgId (keep first occurrence)
  const seen = new Set<string>()
  const unique = auctions.filter((a) => {
    if (seen.has(a.zvgId)) return false
    seen.add(a.zvgId)
    return true
  })

  return { totalReported, auctions: unique }
}

const IMMOBILIEN_OBJ_IDS = ['1', '2', '3', '19', '4', '5', '6', '7', '8', '13', '14', '15', '16', '17']

export function buildSearchBody(landAbk: string, immobilienOnly: boolean): string {
  const params = new URLSearchParams()
  params.set('land_abk', landAbk)
  params.set('ger_id', '0')
  params.set('ger_name', '-- Alle Amtsgerichte --')
  params.set('az1', '')
  params.set('az2', '')
  params.set('az3', '')
  params.set('az4', '')
  params.set('art', '')
  params.set('obj', '')
  if (immobilienOnly) {
    for (const id of IMMOBILIEN_OBJ_IDS) params.append('obj_arr[]', id)
  }
  params.set('str', '')
  params.set('hnr', '')
  params.set('plz', '')
  params.set('ort', '')
  params.set('ortsteil', '')
  params.set('order_by', '2')
  return params.toString()
}
