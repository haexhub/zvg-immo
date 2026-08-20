import { load } from 'cheerio'
import type { Auction } from '~/types/auction'
import { BASE_URL, UA } from './constants'

const FETCH_TIMEOUT_MS = 20_000

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function absoluteUrl(path: string): string {
  return path.startsWith('http') ? path : `${BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`
}

async function fetchDetailHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Accept: 'text/html', 'Accept-Language': 'de-DE,de;q=0.9', 'User-Agent': UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`dga-ag.de detail HTTP ${res.status} for ${url}`)
  return await res.text()
}

/** The free-text "Lage und Umfeld dieser Immobilie" paragraph isn't filled in
 *  for every object. When absent, <meta property="og:description"> falls
 *  back to a site-wide slogan rather than being omitted, so that meta tag
 *  can't be used as a presence check — the label element is. */
function extractDescription($: ReturnType<typeof load>): string | null {
  const label = $('label')
    .filter((_i, el) => $(el).text().trim() === 'Lage und Umfeld dieser Immobilie')
    .first()
  if (!label.length) return null
  const container = label.parent().clone()
  container.find('label').remove()
  return clean(container.text()) || null
}

function extractPhotoUrls($: ReturnType<typeof load>): string[] {
  const srcs = $('.bs-overlay .zoom-handle img')
    .map((_i, el) => $(el).attr('src'))
    .get()
    .filter((src): src is string => Boolean(src))
    .map(absoluteUrl)
  return [...new Set(srcs)]
}

export async function enrichOne(auction: Auction): Promise<void> {
  const url = auction.detailUrlUpstream ?? auction.detailUrl
  if (!url) return
  const html = await fetchDetailHtml(url)
  const $ = load(html)

  const title = clean($('meta[property="og:title"]').attr('content') ?? '')
  if (title) auction.title = title
  auction.description = extractDescription($)

  const photoUrls = extractPhotoUrls($)
  if (photoUrls.length > 0) {
    auction.photoUrls = photoUrls
    auction.photoCount = photoUrls.length
    auction.thumbnailUrl = auction.thumbnailUrl ?? photoUrls[0] ?? null
  }

  const pdfHref = $('a[href*=".pdf"]').first().attr('href')
  if (!pdfHref) return
  const pdfUrl = absoluteUrl(pdfHref)
  auction.pdfUrl = pdfUrl
  auction.pdfUrlUpstream = pdfUrl
  // The linked PDF is the shared multi-lot auction catalog (deep-linked to
  // this object's page via #page=N), not a per-object Gutachten or
  // Bekanntmachung — classifyAttachment's label/filename heuristics don't
  // cover that case, so the kind is set directly. It covers every lot in the
  // catalog, not just this one — pdftotext/pdfimages have no notion of "this
  // object's pages" within it, so neither photo extraction nor LLM document
  // analysis (which would otherwise read the ~90-lot catalog's text/images
  // wholesale and risk reporting a different lot's facts) may use it. The
  // object's own gallery/description already come from the detail page above.
  auction.attachments = [
    {
      kind: 'brochure',
      label: 'Katalog',
      filename: pdfUrl.split('/').pop()?.split('#')[0] || 'katalog.pdf',
      sizeBytes: null,
      fileId: auction.externalId,
      proxyUrl: pdfUrl,
      excludeFromDocumentMining: true,
    },
  ]
}
