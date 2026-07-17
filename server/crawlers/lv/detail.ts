import { load } from 'cheerio'
import type { Attachment, Auction } from '~/types/auction'
import { UA } from './constants'
import { clean } from './text'

export interface LvDetail {
  /** Full-size gallery photos (img.photo, /attachments/<auction>/<file>/…). */
  photoUrls: string[]
  /** "Īpašuma novērtējums" valuation PDF, when published. */
  gutachten: { url: string; fileId: string; filename: string } | null
  kadastraNumurs: string | null
  /** "Domājamās daļas no īpašuma", e.g. "1/1". */
  domajamasDalas: string | null
  lat: number | null
  lng: number | null
  /** Guard against non-detail responses (e.g. a session redirect to the
   *  list): the real page always carries the object-info block. */
  hasContent: boolean
}

export function parseDetailPage(html: string): LvDetail {
  const $ = load(html)

  const photoUrls = [
    ...new Set(
      $('img.photo')
        .map((_, el) => $(el).attr('src'))
        .get()
        .filter(
          (src): src is string =>
            !!src && src.includes('/attachments/') && !src.includes('/gallery-thumbnail/'),
        ),
    ),
  ]

  // Filenames may contain spaces/commas — encode so the stored URL is
  // directly fetchable (fetch() rejects raw spaces).
  const gutachtenHref = $('.valuation-file a').first().attr('href') ?? null
  const gutachten = gutachtenHref
    ? {
        url: encodeURI(gutachtenHref),
        fileId:
          gutachtenHref.match(/attachments\/[a-f0-9-]{36}\/([a-f0-9-]{36})\//)?.[1] ??
          gutachtenHref,
        filename: gutachtenHref.split('/').pop() ?? 'novertejums.pdf',
      }
    : null

  // Several sidebar fields carry .object-data too — the cadastre block is the
  // one whose text contains the label.
  let kadastraNumurs: string | null = null
  let domajamasDalas: string | null = null
  $('.object-data').each((_, el) => {
    const text = clean($(el).text()) ?? ''
    if (kadastraNumurs == null && /Kadastra numurs/i.test(text)) {
      kadastraNumurs =
        clean($(el).find('a').first().text()) ??
        clean(text.match(/Kadastra numurs\s*:?\s*([\d\s]{5,})/)?.[1])
    }
    if (domajamasDalas == null) {
      domajamasDalas = text.match(/Domājamās daļas no īpašuma:\s*(\S+)/)?.[1] ?? null
    }
  })

  const $map = $('.announcement-coordinates i').first()
  const lat = parseFloat($map.attr('data-lat') ?? '')
  const lng = parseFloat($map.attr('data-long') ?? '')

  return {
    photoUrls,
    gutachten,
    kadastraNumurs,
    domajamasDalas,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    hasContent: $('.object-info').length > 0 || $('.auction-main-text').length > 0,
  }
}

export async function enrichOne(auction: Auction): Promise<void> {
  if (!auction.detailUrlUpstream) return
  const res = await fetch(auction.detailUrlUpstream, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'lv,en;q=0.9' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`izsoles.ta.gov.lv detail: HTTP ${res.status}`)
  const d = parseDetailPage(await res.text())
  // Unlike the filtered list, /izsole/<uuid> is served without a session —
  // but if the portal ever answers with a non-detail page (redirect to the
  // search form, maintenance page), throw so the enrich task retries later.
  if (!d.hasContent) throw new Error('izsoles.ta.gov.lv detail: unexpected page without auction content')

  if (d.photoUrls.length > 0) {
    auction.photoUrls = d.photoUrls
    auction.fotoCount = d.photoUrls.length
  }

  if (d.gutachten && !auction.attachments.some((a) => a.fileId === d.gutachten!.fileId)) {
    auction.attachments.push({
      kind: 'gutachten',
      label: 'Īpašuma novērtējums',
      filename: d.gutachten.filename,
      sizeBytes: null,
      fileId: d.gutachten.fileId,
      proxyUrl: d.gutachten.url,
    } satisfies Attachment)
  }

  const lines: string[] = []
  if (d.kadastraNumurs) lines.push(`Kadastra numurs: ${d.kadastraNumurs}`)
  if (d.domajamasDalas) lines.push(`Domājamās daļas no īpašuma: ${d.domajamasDalas}`)
  if (lines.length > 0) {
    // Enrich the notice text from the list crawl — never replace it. Skip
    // lines already present so reruns don't stack duplicate cadastral blocks.
    const missing = lines.filter((line) => !auction.beschreibung?.includes(line))
    if (missing.length > 0) {
      auction.beschreibung = [auction.beschreibung, missing.join('\n')].filter(Boolean).join('\n\n')
    }
  }

  if (d.lat != null && d.lng != null) {
    auction.lat = d.lat
    auction.lng = d.lng
  }
}
