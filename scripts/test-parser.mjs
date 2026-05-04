#!/usr/bin/env node
// Standalone test that runs the live crawler and prints stats.
// Useful for verifying parsing without needing the Nuxt server.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { load } from 'cheerio'

const ZVG_BASE = 'https://www.zvg-portal.de'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

const MONTH_DE = {
  Januar: '01', Februar: '02', März: '03', Maerz: '03', April: '04', Mai: '05',
  Juni: '06', Juli: '07', August: '08', September: '09', Oktober: '10',
  November: '11', Dezember: '12',
}

function parseGermanDateTime(text) {
  const m = text.match(/(\d{1,2})\.\s*(\p{L}+)\s+(\d{4}),?\s*(\d{1,2}):(\d{2})/u)
  if (!m) return null
  const [, d, monthName, y, hh, mm] = m
  const month = MONTH_DE[monthName]
  if (!month) return null
  return `${y}-${month}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:00`
}

function parseGermanTimestamp(text) {
  const m = text.match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/)
  if (!m) return null
  const [, d, mo, y, hh, mm] = m
  return `${y}-${mo}-${d}T${hh}:${mm}:00`
}

function parseEuro(text) {
  const m = text.replace(/\s|&nbsp;/g, '').match(/([\d.]+,\d{2})/)
  if (!m) return null
  const n = m[1].replace(/\./g, '').replace(',', '.')
  const num = parseFloat(n)
  return Number.isFinite(num) ? num : null
}

function decodeEntities(s) {
  return s
    .replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&uuml;/g, 'ü')
    .replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö').replace(/&Uuml;/g, 'Ü')
    .replace(/&szlig;/g, 'ß').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#128;/g, '€').replace(/&euro;/g, '€')
}

function fixMojibake(s) {
  if (!/Ã[-¿]/.test(s)) return s
  return s
    .replace(/Ã¤/g, 'ä').replace(/Ã¶/g, 'ö').replace(/Ã¼/g, 'ü')
    .replace(/Ã„/g, 'Ä').replace(/Ã–/g, 'Ö').replace(/Ãœ/g, 'Ü')
    .replace(/ÃŸ/g, 'ß').replace(/Ã©/g, 'é').replace(/Ã¨/g, 'è')
}

function clean(s) {
  return fixMojibake(decodeEntities(s)).replace(/\s+/g, ' ').trim()
}

function parseAuctionsHtml(html, landAbk) {
  const totalMatch = html.match(/Insgesamt\s+(\d+)/)
  const totalReported = totalMatch ? parseInt(totalMatch[1], 10) : null

  const chunks = html.split('<!--Aktenzeichen--->').slice(1)
  const auctions = []

  for (const rawChunk of chunks) {
    const endMarker = rawChunk.indexOf('<!--Zwangsversteigerungen Ende-->')
    const chunk = endMarker >= 0 ? rawChunk.slice(0, endMarker) : rawChunk
    const $$ = load(`<table>${chunk}</table>`)

    let terminText = null, terminIso = null, aufgehoben = false
    const terminMatch = chunk.match(/<TR>\s*<TD[^>]*>\s*Termin\s*<\/[Tt][Dd]>([\s\S]*?)<\/[Tt][Rr]>/i)
    if (terminMatch) {
      const inner = terminMatch[1].replace(/<[^>]+>/g, ' ')
      const decoded = clean(inner)
      aufgehoben = /aufgehoben/i.test(decoded)
      terminText = decoded || null
      terminIso = parseGermanDateTime(decoded)
    }

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
    let bundeslandName = ''
    const amtMatch = chunk.match(/<!--Amtsgericht--->[\s\S]*?<b>\s*([\s\S]*?)\s+in\s+([\s\S]*?)<\/b>/i)
    if (amtMatch) {
      amtsgericht = clean(amtMatch[1])
      bundeslandName = clean(amtMatch[2])
    }

    let objekt = null, adresse = null
    const lageMatch = chunk.match(/<b>([^<]+?)<!--Lage--->\s*:?\s*<\/b>\s*([^<\n]+)/)
    if (lageMatch) {
      objekt = clean(lageMatch[1])
      adresse = clean(lageMatch[2])
    }

    let verkehrswertEur = null, verkehrswertText = null
    const vwMatch = chunk.match(/Verkehrswert in[\s\S]*?<b>([\s\S]*?)<\/b>/)
    if (vwMatch) {
      const inner = vwMatch[1].replace(/<[^>]+>/g, ' ')
      verkehrswertText = clean(inner) || null
      verkehrswertEur = parseEuro(inner)
    }

    let pdfUrl = null
    const pdfMatch = chunk.match(/href="([^"]*showAnhang[^"]*)"/i)
    if (pdfMatch) pdfUrl = `${ZVG_BASE}/${pdfMatch[1].trim().replace(/\s+$/, '')}`

    auctions.push({
      zvgId, aktenzeichen, amtsgericht, bundesland: bundeslandName,
      objekt, adresse, verkehrswertEur, verkehrswertText,
      terminIso, terminText, aufgehoben, letzteAktualisierungIso,
      pdfUrl,
      detailUrl: detailHref ? `${ZVG_BASE}/${detailHref.replace(/^\/+/, '')}` : null,
    })
  }

  const seen = new Set()
  const unique = auctions.filter((a) => {
    if (seen.has(a.zvgId)) return false
    seen.add(a.zvgId)
    return true
  })

  return { totalReported, auctions: unique }
}

const OBJ_IDS = ['1','2','3','19','4','5','6','7','8','13','14','15','16','17']

async function fetchLive(immobilienOnly = true) {
  const params = new URLSearchParams()
  params.set('land_abk', 'sn')
  params.set('ger_id', '0')
  params.set('ger_name', '-- Alle Amtsgerichte --')
  params.set('art', '')
  params.set('order_by', '2')
  if (immobilienOnly) for (const id of OBJ_IDS) params.append('obj_arr[]', id)

  const res = await fetch(`${ZVG_BASE}/index.php?button=Suchen&all=1`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${ZVG_BASE}/index.php?button=Termine+suchen`,
      'Accept-Language': 'de-DE,de;q=0.9',
    },
    body: params.toString(),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

const useCache = process.argv.includes('--cache')
const cachePath = '/tmp/zvg_live.html'

const html = useCache && existsSync(cachePath)
  ? readFileSync(cachePath, 'utf8')
  : await fetchLive(true)

if (!useCache) {
  writeFileSync('/tmp/zvg_live.html', html, 'utf8')
}

const result = parseAuctionsHtml(html, 'sn')
console.log(`Total reported: ${result.totalReported}`)
console.log(`Parsed entries: ${result.auctions.length}`)
console.log(`Aufgehoben:     ${result.auctions.filter(a => a.aufgehoben).length}`)
console.log('--- First 3 entries ---')
console.log(JSON.stringify(result.auctions.slice(0, 3), null, 2))
console.log('--- Sanity ---')
const missingObjekt = result.auctions.filter(a => !a.aufgehoben && !a.objekt).length
const missingTermin = result.auctions.filter(a => !a.terminText).length
const missingVw = result.auctions.filter(a => !a.aufgehoben && a.verkehrswertEur == null).length
const missingPdf = result.auctions.filter(a => !a.aufgehoben && !a.pdfUrl).length
console.log(`active without objekt:        ${missingObjekt}`)
console.log(`entries without terminText:   ${missingTermin}`)
console.log(`active without verkehrswert:  ${missingVw}`)
console.log(`active without pdf:           ${missingPdf}`)
