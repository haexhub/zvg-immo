import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { EE_BASE, LIST_PATH, COUNTRY, UA, DETAIL_CONCURRENCY } from './constants'
import { clean, parseEeDateTime, parseEePrice, stripAnnouncementHtml } from './text'

const MAX_LIST_PAGES = 20

function mergeCookies(existing: string, setCookieHeaders: string[]): string {
  const jar = new Map<string, string>(
    existing
      .split('; ')
      .filter(Boolean)
      .map((c) => {
        const eq = c.indexOf('=')
        return [c.slice(0, eq), c.slice(eq + 1)] as [string, string]
      }),
  )
  for (const entry of setCookieHeaders) {
    const pair = (entry.split(';')[0] ?? '').trim()
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/** The list view exposes no clean detail fields (address, dates) — only a
 *  live countdown widget — so pagination here only harvests okids; every
 *  field is scraped from the per-lot detail page instead. */
async function fetchActiveIds(): Promise<string[]> {
  const seen = new Set<string>()
  let cookies = ''

  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'et,en;q=0.9',
    }
    if (cookies) headers['Cookie'] = cookies

    const res = await fetch(`${EE_BASE}${LIST_PATH}&onpage=50&page=${page}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      if (seen.size > 0) break
      throw new Error(`oksjonikeskus.ee list fetch failed: ${res.status}`)
    }
    const setCookie = res.headers.getSetCookie?.() ?? []
    if (setCookie.length > 0) cookies = mergeCookies(cookies, setCookie)

    const html = await res.text()
    const ids = [...html.matchAll(/okid=(\d+)/g)].map((m) => m[1]!)
    const before = seen.size
    for (const id of ids) seen.add(id)
    if (seen.size === before) break
  }

  return [...seen]
}

function extractInfoTable($: ReturnType<typeof load>): Map<string, string> {
  const info = new Map<string, string>()
  $('tr').each((_, tr) => {
    const $tr = $(tr)
    const $labelCell = $tr.children('td, th').first()
    const strongText = $labelCell.find('strong').first().text()
    const label = strongText.replace(':', '').trim().toLowerCase()
    if (!label) return
    const $valueCell = $labelCell.next('td, th')
    if ($valueCell.length === 0) return
    const value = clean($valueCell.text())
    if (value) info.set(label, value)
  })
  return info
}

function mapDetail(id: string, html: string, platformId: string): Auction | null {
  const $ = load(html)
  const info = extractInfoTable($)

  const title = clean($('h2.bigTitle').first().text()) ?? ''
  const aufgehoben = title.toLowerCase().includes('peatatud')

  const { iso: terminIso, label: terminText } = parseEeDateTime(info.get('oksjoni lõpp') ?? null)

  const linnVald = info.get('linn / vald')
  const aadressRaw = info.get('aadress')
  const adresse =
    aadressRaw && linnVald && !aadressRaw.includes(linnVald)
      ? `${linnVald}, ${aadressRaw}`
      : (aadressRaw ?? linnVald ?? null)

  const priceRaw = info.get('alghind oksjonil')
  const verkehrswertEur = parseEePrice(priceRaw ?? null)

  const announcementHtml = $('.announcement-body').first().html()
  const beschreibung = announcementHtml ? stripAnnouncementHtml(announcementHtml) || null : null

  const photoUrls = [...new Set(
    $('img')
      .map((_, img) => $(img).attr('src'))
      .get()
      .filter((src): src is string => !!src && src.startsWith('/media/')),
  )]
  const thumbnailUrl = photoUrls[0] ? `${EE_BASE}${photoUrls[0]}` : null

  const detailUrl = `${EE_BASE}/oksjon/view/?okid=${id}`

  return {
    platform: platformId,
    country: COUNTRY,
    region: '',
    zvgId: id,
    aktenzeichen: '',
    amtsgericht: info.get('oksjoni korraldaja') ?? '',
    objekt: title || null,
    adresse,
    verkehrswertEur,
    verkehrswertText: priceRaw ?? null,
    terminIso,
    terminText,
    aufgehoben,
    letzteAktualisierungIso: null,
    pdfUrl: null,
    detailUrl,
    pdfUrlUpstream: `${EE_BASE}/oksjon/dopdf/?okid=${id}`,
    detailUrlUpstream: detailUrl,
    attachments: [],
    beschreibung,
    fotoCount: photoUrls.length,
    thumbnailUrl,
  }
}

export async function fetchAllListings(
  platformId: string,
): Promise<{ auctions: Auction[]; total: number | null }> {
  const ids = await fetchActiveIds()
  if (ids.length === 0) return { auctions: [], total: 0 }

  const htmls: (string | null)[] = new Array(ids.length).fill(null)
  let cursor = 0
  async function worker() {
    while (cursor < ids.length) {
      const i = cursor++
      const id = ids[i]
      if (!id) continue
      try {
        const res = await fetch(`${EE_BASE}/oksjon/view/?okid=${id}`, {
          headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
          signal: AbortSignal.timeout(20_000),
        })
        htmls[i] = res.ok ? await res.text() : null
      } catch {
        htmls[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker))

  const auctions = ids
    .map((id, i) => (htmls[i] ? mapDetail(id, htmls[i]!, platformId) : null))
    .filter((a): a is Auction => a !== null)

  return { auctions, total: auctions.length }
}
