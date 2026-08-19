import { load, type CheerioAPI } from 'cheerio'
import type { Auction } from '~/types/auction'
import { fetchKipPage } from './fetch'
import { absoluteUrl, applyAreaFacts, clean } from './text'

/** Marker substring of the disclaimer kip.net shows instead of a street
 *  address when the Anbieter hasn't released it ("Die genaue Adresse des
 *  Objekts ist vom Anbieter nicht freigegeben. In der Karte ist daher die
 *  ungefähre Lage der Immobilie dargestellt.") — verified live on several
 *  private listings. Roughly half of the sampled objects show this instead
 *  of a real address. */
const ADDRESS_UNDISCLOSED_MARKER = 'nicht freigegeben'

/** Every "exposeInfoBox" on the detail page (the quick-facts sidebar, the
 *  fuller "Angaben zur Immobilie" table, "Objektbeschreibung",
 *  "Objektadresse", "Anbieter dieses Objekts", ...) shares one markup shape:
 *  an optional ".exposeInfoBoxHeader" with the section's own <h2>, followed
 *  by a plain content <div>. Locates that content <div> by heading text. */
function sectionBox($: CheerioAPI, heading: string) {
  const h2 = $('.exposeInfoBoxHeader h2')
    .filter((_i, el) => $(el).text().trim() === heading)
    .first()
  return h2.length ? h2.closest('.exposeInfoBox') : null
}

/** Replaces every "<br>" with a space before reading .text(), so two
 *  sentences joined only by a line break don't run together — relying on
 *  the live template's own incidental newlines after each "<br/>" in the
 *  source would be fragile against a formatting-only markup change.
 *  Operates on a clone so it never mutates the page's own DOM. */
function sectionText($: CheerioAPI, heading: string): string | null {
  const box = sectionBox($, heading)
  if (!box) return null
  const content = box.children('div').eq(1).clone()
  content.find('br').replaceWith(' ')
  return clean(content.text()) || null
}

/** The disclosed form is "<Straße Hausnr.><br/><PLZ> <Stadt>" — replace the
 *  <br/> with a newline on a clone (so the page's own DOM stays intact) and
 *  read .text(), which keeps street and city as separate, comma-joined parts
 *  while letting Cheerio decode character references for us. Serialising the
 *  box with .html() instead would re-encode them, storing an address that
 *  literally reads "Muster &amp; Söhne 3". Returns null both when the section
 *  is missing and when it's the "nicht freigegeben" disclaimer — callers keep
 *  the postal-code-only address list.ts already set in that case. */
function extractAddressOverride($: CheerioAPI): string | null {
  const box = sectionBox($, 'Objektadresse')
  if (!box) return null
  const content = box.children('div').eq(1).clone()
  content.find('br').replaceWith('\n')
  const text = content.text()
  // clean() first: the disclaimer arrives with a non-breaking space between
  // "nicht" and "freigegeben" on some listings, which a raw substring check
  // would miss.
  if (clean(text).includes(ADDRESS_UNDISCLOSED_MARKER)) return null
  const lines = text
    .split('\n')
    .map((line) => clean(line))
    .filter(Boolean)
  return lines.length > 0 ? lines.join(', ') : null
}

/** The Anbieter name always links to its own "/anbieter/<slug>" profile page
 *  inside the "Anbieter dieses Objekts" box — this covers the Kommune,
 *  Makler and Privatperson cases alike (all sampled live) since the field
 *  means "whoever is offering this object", not specifically a public body. */
function extractAuthority($: CheerioAPI): string | null {
  const box = sectionBox($, 'Anbieter dieses Objekts')
  if (!box) return null
  return clean(box.find('a[href^="/anbieter/"]').first().text()) || null
}

function extractFacts($: CheerioAPI): Map<string, string> {
  const facts = new Map<string, string>()
  $('.exposeInfoBoxRow').each((_i, el) => {
    const $row = $(el)
    const key = clean($row.find('.exposeInfoBoxKey').first().text())
    const value = clean($row.find('.exposeInfoBoxValue').first().text())
    if (key && value && !facts.has(key)) facts.set(key, value)
  })
  return facts
}

/** The photo slider markup is duplicated verbatim for a small- and a
 *  medium/large-viewport version of the same gallery (verified live: every
 *  URL appears exactly twice) — deduped via Set, same convention as
 *  dga-ag/detail.ts and gb/detail.ts. */
function extractPhotoUrls($: CheerioAPI): string[] {
  const srcs = $('[data-u="image"]')
    .map((_i, el) => $(el).attr('src'))
    .get()
    .filter((src): src is string => Boolean(src))
    .map(absoluteUrl)
  return [...new Set(srcs)]
}

/**
 * No PDF attachment is produced: the "Exposé als PDF" button on this template
 * generates a document on demand client-side from checkbox options (which
 * photos, which sections) rather than linking a static file, and everything
 * it would contain (price, address, description, photos) is already captured
 * structurally above — attaching it would add no information for this PoC.
 *
 * lat/lng are deliberately left untouched: the page's own
 * <meta name="geo.position"> is NOT per-object — verified live identical
 * ("53.55;10") across multiple distinct Hamburg listings with different
 * postal codes, i.e. a fixed city-level pin baked into the shared template.
 * Using it would inject misleading precision; the address text this
 * function sets is geocoded centrally instead (server/tasks/geocode.ts).
 */
export async function enrichOne(auction: Auction): Promise<void> {
  const url = auction.detailUrlUpstream ?? auction.detailUrl
  if (!url) return
  const { html } = await fetchKipPage(url, 'GET', undefined, null)
  const $ = load(html)

  const authority = extractAuthority($)
  if (authority) auction.authority = authority

  const address = extractAddressOverride($)
  if (address) auction.address = address

  auction.description = sectionText($, 'Objektbeschreibung')

  applyAreaFacts(auction, extractFacts($))

  const photoUrls = extractPhotoUrls($)
  if (photoUrls.length > 0) {
    auction.photoUrls = photoUrls
    auction.photoCount = photoUrls.length
    auction.thumbnailUrl = auction.thumbnailUrl ?? photoUrls[0] ?? null
  }
}
