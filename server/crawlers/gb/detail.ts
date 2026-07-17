import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { GB_BASE, GB_ONLINE_BASE, UA, ONLINE_CRAWL_DELAY_MS } from './constants'

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function absoluteUrl(href: string): string {
  return href.startsWith('http') ? href : `${GB_BASE}${href.startsWith('/') ? '' : '/'}${href}`
}

/** online.auctionhouse.co.uk's robots.txt declares `Crawl-delay: 5`. enrichOne
 *  is called with concurrency by the enrich task (server/tasks/enrich.ts), so
 *  a per-call delay alone wouldn't actually space out requests when several
 *  GB lots are being enriched at once — this serialises every fetch to this
 *  host through one queue with a 5s minimum gap, regardless of how many
 *  callers are in flight. */
let onlineQueue: Promise<unknown> = Promise.resolve()
let lastOnlineFetchAt = 0

async function onlineFetch(url: string): Promise<Response> {
  const run = onlineQueue.then(async () => {
    const wait = lastOnlineFetchAt + ONLINE_CRAWL_DELAY_MS - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastOnlineFetchAt = Date.now()
    return fetch(url, {
      headers: { Accept: 'text/html', 'Accept-Language': 'en-GB,en;q=0.9', 'User-Agent': UA },
      signal: AbortSignal.timeout(20_000),
    })
  })
  // Keep the queue alive even if this fetch fails, so later callers aren't
  // stuck behind a rejected promise forever.
  onlineQueue = run.catch(() => undefined)
  return run
}

interface DetailInfo {
  terminIso: string | null
  terminText: string | null
  beschreibung: string | null
  photoUrls: string[]
  lat: number | null
  lng: number | null
}

/** Own-site lot pages (www.auctionhouse.co.uk/<region>/auction/lot/<id>) —
 *  traditional room/livestream auctions, batched under one date+time. No
 *  coordinates: the map embed here is only a postcode search, not a
 *  lat/lng pin (unlike the online-auction template below). */
export function parseOwnDetail(html: string): DetailInfo {
  const $ = load(html)

  const dateText = clean($('.auction-info-header:contains("Auction Date")').first().next('p').text())
  const timeText = clean($('.auction-info-header:contains("Auction Time")').first().next('p').text())
  const dm = dateText.match(/(\d{2})\/(\d{2})\/(\d{4})/)
  const tm = timeText.match(/^(\d{2}):(\d{2})/)
  const terminIso = dm ? `${dm[3]}-${dm[2]}-${dm[1]}T${tm ? `${tm[1]}:${tm[2]}` : '00:00'}:00` : null
  const terminText = [dateText, timeText].filter(Boolean).join(' ') || null

  // .preline's direct <p> children alternate a bold "label" paragraph
  // (Tenure, Location, Accommodation, Exterior, Services, ...) and the free
  // text under it. The "Important Notice to Prospective Buyers"/"Additional
  // Fees" boilerplate further down lives in a nested wrapper div, so this
  // direct-child selector naturally stops before it and keeps just the
  // actual property description.
  const sections: string[] = []
  $('.preline > p').each((_i, el) => {
    const $p = $(el)
    const text = clean($p.text())
    if (!text) return
    if ($p.hasClass('auction-info-header') || sections.length === 0) sections.push(text)
    else sections[sections.length - 1] += `\n${text}`
  })
  const beschreibung = sections.join('\n\n') || null

  const photoUrls = [
    ...new Set(
      $('.carousel-inner img')
        .map((_i, el) => $(el).attr('src'))
        .get()
        .filter((src): src is string => Boolean(src))
        .map(absoluteUrl),
    ),
  ]

  return { terminIso, terminText, beschreibung, photoUrls, lat: null, lng: null }
}

const STOP_HEADINGS = /^(important notice|administration charge|note\b|additional fees|disbursements)/i

/** online.auctionhouse.co.uk/lot/details/<guid> — the online-bidding
 *  template. Unlike the own-site template, its Google Maps embed carries the
 *  actual lat/lng (`.../maps/embed/v1/place?q=<lat>,<lng>`), and there's no
 *  single scheduled date+time — only a bidding open time and a closing date
 *  (only the date, no time, is published outside the JS-rendered countdown),
 *  taken from the page's own meta description. */
export function parseOnlineDetail(html: string): DetailInfo {
  const $ = load(html)

  const metaDescription = $('meta[name="description"]').attr('content') ?? ''
  const closingDate = metaDescription.match(/closing on (\d{2})\/(\d{2})\/(\d{4})/)
  const terminIso = closingDate ? `${closingDate[3]}-${closingDate[2]}-${closingDate[1]}` : null
  const opensText = clean($('.lot-highlights li:contains("Bidding Opens")').first().text())
  const terminText = [opensText, closingDate ? `Closes ${closingDate[0].replace('closing on ', '')}` : null]
    .filter(Boolean)
    .join(' · ') || null

  // Each field section is an <h4>label</h4> followed by one or more <p>
  // (the markup nests a stray <p><p>...</p></p> — cheerio auto-closes the
  // outer one, leaving an empty <p></p> before the real text, so pick the
  // first non-empty one). Stops at the first boilerplate/fees heading.
  const sections: string[] = []
  const h4s = $('h4').toArray()
  for (const h4 of h4s) {
    const $h4 = $(h4)
    const label = clean($h4.text())
    if (!label) continue
    if (STOP_HEADINGS.test(label)) break
    const text = clean(
      $h4
        .nextUntil('h4', 'p')
        .filter((_i, p) => clean($(p).text()).length > 0)
        .first()
        .text(),
    )
    sections.push(text ? `${label}\n${text}` : label)
  }
  const beschreibung = sections.join('\n\n') || null

  const photoUrls = [
    ...new Set(
      $('#carousel-lot-images .carousel-inner img')
        .map((_i, el) => $(el).attr('src'))
        .get()
        .filter((src): src is string => Boolean(src)),
    ),
  ]

  const latLng = html.match(/maps\/embed\/v1\/place\?q=(-?[\d.]+),(-?[\d.]+)/)
  const lat = latLng ? Number(latLng[1]) : NaN
  const lng = latLng ? Number(latLng[2]) : NaN

  return {
    terminIso,
    terminText,
    beschreibung,
    photoUrls,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  }
}

export async function enrichOne(auction: Auction): Promise<void> {
  const href = auction.detailUrlUpstream
  if (!href) return
  const url = new URL(href)

  let detail: DetailInfo
  if (url.origin === new URL(GB_ONLINE_BASE).origin) {
    // "Legal pack" links on this template (both /lot/legals/<id> here and
    // legaldocuments.eigroup.co.uk linked from the own-site template) 302 to
    // an account login for every lot sampled during development — the PDF
    // itself is never actually reachable without an account, so it's never
    // added as an attachment (would just be a login page behind our proxy).
    const res = await onlineFetch(href)
    if (!res.ok) throw new Error(`online.auctionhouse.co.uk detail: HTTP ${res.status}`)
    detail = parseOnlineDetail(await res.text())
  } else if (url.origin === new URL(GB_BASE).origin) {
    const res = await fetch(href, {
      headers: { Accept: 'text/html', 'Accept-Language': 'en-GB,en;q=0.9', 'User-Agent': UA },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`auctionhouse.co.uk detail: HTTP ${res.status}`)
    detail = parseOwnDetail(await res.text())
  } else {
    // A handful of branches host their online lots on their own
    // eigonlineauctions.com subdomain instead of online.auctionhouse.co.uk
    // (e.g. ahlondon-uk.eigonlineauctions.com) — same template, but a
    // domain outside the two this crawler's robots.txt research covered.
    // Left un-enriched rather than guessing at that domain's crawl policy;
    // the list-card fields (address, guide price, type, thumbnail) still
    // populate the auction.
    return
  }

  if (detail.terminIso) {
    auction.terminIso = detail.terminIso
    auction.terminText = detail.terminText
  }
  if (detail.beschreibung) auction.beschreibung = detail.beschreibung
  if (detail.photoUrls.length > 0) {
    auction.photoUrls = detail.photoUrls
    auction.fotoCount = detail.photoUrls.length
    auction.thumbnailUrl = detail.photoUrls[0] ?? auction.thumbnailUrl
  }
  if (detail.lat != null && detail.lng != null) {
    auction.lat = detail.lat
    auction.lng = detail.lng
  }
}
