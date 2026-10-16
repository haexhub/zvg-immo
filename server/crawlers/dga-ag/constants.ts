import type { RegionInfo } from '../types'

export const BASE_URL = 'https://www.dga-ag.de'
export const LIST_URL = `${BASE_URL}/immobilie-ersteigern/immobilie-suchen-und-finden.html`
export const PLATFORM_ID = 'dga-ag'
export const COUNTRY = 'de'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

/**
 * The public search page is a shared catalog across five affiliated auction
 * houses, each running its own catalogs and auction dates on its own domain
 * (ndga.de, sga-ag.de, wdga-ag.de, plettner-brecht.de) — the single-letter
 * prefix in an object's Katalog-Nr (e.g. "N26-03-001") identifies which one
 * actually sells it. There is no per-object auction date on dga-ag.de itself
 * (only a site-wide "nächste Auktion" banner for DGA AG's own catalog), so
 * `auctionDateIso`/`auctionDateText` are left null — resolving the real date
 * would mean crawling four more external calendar pages and cross-matching
 * catalog codes, out of scope for this adapter. Labels are the site's own
 * filter-dropdown wording (`select[name="veranstaltungen"]`), used verbatim
 * as `authority` rather than an invented full company name.
 */
export const AUCTION_HOUSE_LABELS: Record<string, string> = {
  d: 'DGA AG',
  s: 'SGA AG',
  n: 'NDGA AG',
  w: 'WDGA AG',
  i: 'DIIA',
  p: 'P&B GmbH',
}

/**
 * All 16 Bundesländer plus 'Ausland' — dga-ag.de's own `select[name="region"]`
 * filter facet. Codes reuse zvg-portal's convention for the 13 states they
 * share, extended with Hamburg/Mecklenburg-Vorpommern/Schleswig-Holstein
 * (using the same codes mv-zvgcom already registers for those three) since
 * DGA, unlike the court portals, covers them directly.
 */
export const DGA_REGIONS: readonly RegionInfo[] = [
  { code: 'bw', name: 'Baden-Württemberg' },
  { code: 'by', name: 'Bayern' },
  { code: 'be', name: 'Berlin' },
  { code: 'br', name: 'Brandenburg' },
  { code: 'hb', name: 'Bremen' },
  { code: 'hh', name: 'Hamburg' },
  { code: 'he', name: 'Hessen' },
  { code: 'mv', name: 'Mecklenburg-Vorpommern' },
  { code: 'ni', name: 'Niedersachsen' },
  { code: 'nw', name: 'Nordrhein-Westfalen' },
  { code: 'rp', name: 'Rheinland-Pfalz' },
  { code: 'sl', name: 'Saarland' },
  { code: 'sn', name: 'Sachsen' },
  { code: 'st', name: 'Sachsen-Anhalt' },
  { code: 'sh', name: 'Schleswig-Holstein' },
  { code: 'th', name: 'Thüringen' },
  { code: 'ausland', name: 'Ausland' },
] as const

export const DGA_REGION_NAMES: Record<string, string> = Object.fromEntries(
  DGA_REGIONS.map((r) => [r.code, r.name]),
)
