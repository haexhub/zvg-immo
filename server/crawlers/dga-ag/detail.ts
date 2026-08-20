import { load } from 'cheerio'
import type { Attachment, Auction } from '~/types/auction'
import { BASE_URL, UA } from './constants'
import { getDgaAgSessionCookie } from './session'

const FETCH_TIMEOUT_MS = 20_000

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function absoluteUrl(path: string): string {
  return path.startsWith('http') ? path : `${BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`
}

async function fetchDetailHtml(url: string, cookie: string | null): Promise<{ html: string; finalUrl: string }> {
  const res = await fetch(url, {
    headers: {
      Accept: 'text/html',
      'Accept-Language': 'de-DE,de;q=0.9',
      'User-Agent': UA,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`dga-ag.de detail HTTP ${res.status} for ${url}`)
  return { html: await res.text(), finalUrl: res.url }
}

/**
 * Logged in, the page additionally renders a real "Objektunterlagen" link
 * (per-object PDF); anonymously it's just a login-prompt with no href. A
 * felogin session that expired since it was cached redirects this page back
 * to /login.html instead of erroring — detected via the final response URL
 * (not a thrown error), so one re-login and retry recovers instead of
 * silently falling back to the public view for the rest of the crawl run.
 */
async function fetchAuthenticatedDetailHtml(url: string): Promise<string> {
  const cookie = await getDgaAgSessionCookie()
  if (!cookie) return (await fetchDetailHtml(url, null)).html
  const first = await fetchDetailHtml(url, cookie)
  if (!first.finalUrl.includes('/login.html')) return first.html
  const fresh = await getDgaAgSessionCookie({ forceRefresh: true })
  if (!fresh) return first.html
  return (await fetchDetailHtml(url, fresh)).html
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

/** Only rendered when logged in — anonymously "Objektunterlagen" is a
 *  login-prompt div with no href. Genuinely scoped to this one object
 *  (verified live: a 40-page Energieausweis/Grundriss/Flurkarte dossier for
 *  S26-03-011 with zero mentions of any other object number), unlike the
 *  shared multi-lot catalog below. The signed URL's JWT is valid ~25h from
 *  this fetch; enrich-worker.ts downloads/archives attachments in the same
 *  run right after enrichOne, well inside that window. */
function extractObjectDocumentUrl($: ReturnType<typeof load>): string | null {
  const href = $('a[href*="/securedl/"]').first().attr('href')
  return href ? absoluteUrl(href) : null
}

export async function enrichOne(auction: Auction): Promise<void> {
  const url = auction.detailUrlUpstream ?? auction.detailUrl
  if (!url) return
  const html = await fetchAuthenticatedDetailHtml(url)
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

  const attachments: Attachment[] = []

  const pdfHref = $('a[href*="user_upload/api/kataloge"]').first().attr('href')
  if (pdfHref) {
    const pdfUrl = absoluteUrl(pdfHref)
    auction.pdfUrl = pdfUrl
    auction.pdfUrlUpstream = pdfUrl
    // The linked PDF is the shared multi-lot auction catalog (deep-linked to
    // this object's page via #page=N), not a per-object Gutachten or
    // Bekanntmachung — classifyAttachment's label/filename heuristics don't
    // cover that case, so the kind is set directly.
    attachments.push({
      kind: 'brochure',
      label: 'Katalog',
      filename: pdfUrl.split('/').pop()?.split('#')[0] || 'katalog.pdf',
      sizeBytes: null,
      fileId: auction.externalId,
      proxyUrl: pdfUrl,
    })
  }

  const objectDocumentUrl = extractObjectDocumentUrl($)
  if (objectDocumentUrl) {
    attachments.push({
      kind: 'appraisal',
      label: 'Objektunterlagen',
      filename: objectDocumentUrl.split('/').pop()?.split(/[?#]/)[0] || `${auction.externalId}.pdf`,
      sizeBytes: null,
      fileId: `${auction.externalId}-unterlagen`,
      proxyUrl: objectDocumentUrl,
    })
  }

  if (attachments.length > 0) auction.attachments = attachments
}
