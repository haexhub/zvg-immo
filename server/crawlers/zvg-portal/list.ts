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
  const totalReported = totalMatch?.[1] ? parseInt(totalMatch[1], 10) : null

  // Each entry block is delimited by the comment markers + a final <hr>.
  // Strategy: split the raw HTML at "<!--Aktenzeichen--->" and parse each chunk.
  const chunks = html.split('<!--Aktenzeichen--->').slice(1)
  const auctions: Auction[] = []

  for (const rawChunk of chunks) {
    const endMarker = rawChunk.indexOf('<!--Zwangsversteigerungen Ende-->')
    const chunk = endMarker >= 0 ? rawChunk.slice(0, endMarker) : rawChunk
    const $$ = load(`<table>${chunk}</table>`)

    // Termin first — we need to know if it's cancelled before deciding on ID strategy.
    let auctionDateText: string | null = null
    let auctionDateIso: string | null = null
    let cancelled = false
    // <TR[^>]*> — live HTML sometimes renders "<TR >" with a stray space.
    const terminMatch = chunk.match(/<TR[^>]*>\s*<TD[^>]*>\s*Termin\s*<\/[Tt][Dd]>([\s\S]*?)<\/[Tt][Rr]>/i)
    if (terminMatch?.[1]) {
      const inner = terminMatch[1].replace(/<[^>]+>/g, ' ')
      const decoded = clean(inner)
      cancelled = /aufgehoben/i.test(decoded)
      auctionDateText = decoded || null
      auctionDateIso = parseGermanDateTime(decoded)
    }

    // ID extraction
    const caseNumberAnchor = $$('a[href*="showZvg"]').first()
    const detailHref = caseNumberAnchor.attr('href') || ''
    const zvgIdMatch = (chunk.match(/zvg_id=(\d+)/) || [])[1] || null

    let caseNumber = ''
    if (caseNumberAnchor.length) {
      caseNumber = caseNumberAnchor.text().replace(/\(Detailansicht\)/i, '').trim()
    } else {
      const azMatch = chunk.match(/<nobr>\s*(\d+\s+K\s+\d+\/\d+)\s*(?:&nbsp;)?\s*(?:\(Detailansicht\))?\s*<\/nobr>/i)
      if (azMatch?.[1]) caseNumber = azMatch[1].trim()
    }
    caseNumber = clean(caseNumber)
    if (!caseNumber && !zvgIdMatch) continue

    const externalId = zvgIdMatch || `az:${caseNumber}`

    const updateMatch = chunk.match(/letzte Aktualisierung\s+([\d-]+\s+[\d:]+)/)
    const sourceUpdatedIso = updateMatch?.[1] ? parseGermanTimestamp(updateMatch[1]) : null

    let authority = ''
    // Region name comes from landAbk (canonical), not from the HTML.
    // Upstream is inconsistent — e.g. BW renders as "Baden-Wuerttemberg" without
    // umlaut. landAbk is what we asked for and DE_REGION_NAMES is canonical.
    const regionName = DE_REGION_NAMES[landAbk] || landAbk
    // Capture only the first bold-ish tag (<b> or <strong> — upstream switched
    // from one to the other at some point, and both still show up) after the
    // Amtsgericht marker, with no nested tags ([^<]+). A previous greedy
    // variant matched across the entire chunk and bled into later bold blocks
    // (Verkehrswert/Termin) when their text contained " in " (e.g.
    // "Sicherheitsleistung in Höhe …"). The captured text has the form
    // "<court> in <bundesland>"; courts can themselves contain " in " (e.g.
    // "Landau in der Pfalz"), so split on the LAST occurrence.
    const amtMatch = chunk.match(/<!--Amtsgericht--->[\s\S]*?<(?:b|strong)>\s*([^<]+?)\s*<\/(?:b|strong)>/i)
    if (amtMatch?.[1]) {
      const inner = clean(amtMatch[1])
      const sep = inner.lastIndexOf(' in ')
      authority = sep >= 0 ? inner.slice(0, sep) : inner
    }

    let title: string | null = null
    let address: string | null = null
    const lageMatch = chunk.match(/<(?:b|strong)>([^<]+?)<!--Lage--->\s*:?\s*<\/(?:b|strong)>\s*([^<\n]+)/)
    if (lageMatch?.[1] && lageMatch[2]) {
      title = clean(lageMatch[1])
      address = clean(lageMatch[2])
    }

    let marketValueEur: number | null = null
    let marketValueText: string | null = null
    const vwMatch = chunk.match(/Verkehrswert in[\s\S]*?<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>/)
    if (vwMatch?.[1]) {
      const inner = vwMatch[1].replace(/<[^>]+>/g, ' ')
      marketValueText = clean(inner) || null
      marketValueEur = parseEuro(inner)
    }

    let pdfUrl: string | null = null
    let pdfUrlUpstream: string | null = null
    const pdfMatch = chunk.match(/href="([^"]*showAnhang[^"]*)"/i)
    if (pdfMatch?.[1]) {
      const raw = pdfMatch[1].trim().replace(/\s+$/, '')
      pdfUrlUpstream = `${ZVG_BASE}/${raw.replace(/^\/+/, '')}`
      pdfUrl = pdfUrlUpstream
    }

    const detailUrlUpstream = detailHref
      ? `${ZVG_BASE}/${detailHref.replace(/^\/+/, '')}`
      : zvgIdMatch
        ? `${ZVG_BASE}/index.php?button=showZvg&zvg_id=${zvgIdMatch}&land_abk=${landAbk}`
        : `${ZVG_BASE}/index.php?button=Termine+suchen`

    // The app has one canonical detail page assembled from stored data.
    // Upstream HTML is retained only as crawler/archive metadata and is never
    // exposed through a same-origin proxy.
    const detailUrl = null

    auctions.push({
      platform: platformId,
      country: COUNTRY,
      region: regionName,
      externalId,
      caseNumber,
      authority,
      title,
      address,
      marketValueEur,
      marketValueText,
      auctionDateIso,
      auctionDateText,
      cancelled,
      sourceUpdatedIso,
      pdfUrl,
      detailUrl,
      pdfUrlUpstream,
      detailUrlUpstream,
      attachments: [],
      description: null,
      photoCount: 0,
      thumbnailUrl: null,
    })
  }

  // Deduplicate by externalId (keep first occurrence)
  const seen = new Set<string>()
  const unique = auctions.filter((a) => {
    if (seen.has(a.externalId)) return false
    seen.add(a.externalId)
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
