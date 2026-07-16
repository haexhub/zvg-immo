import type { Auction, CrawlResult } from '~/types/auction'
import type { CrawlOptions, PlatformCrawler, RegionInfo } from './types'
import { zvgPortalCrawler } from './zvg-portal'
import { boeCrawler } from './boe'
import { zvbawuCrawler } from './zvbawu'
import { mvZvgcomCrawler } from './mv-zvgcom'
import { atEdikteCrawler } from './at'
import { bidditCrawler } from './biddit'
import { agiCrawler } from './agi'
import { plKomornikCrawler } from './pl'
import { czPortaldrazebCrawler } from './cz'
import { mnvCrawler } from './hu'
import { eaukcionaiCrawler } from './lt'
import { pravosudijeCrawler } from './ba'
import { kronofogdenCrawler } from './se'
import { huutokaupatCrawler } from './fi'
import { tvangsauktionerCrawler } from './dk'
import { licitorCrawler } from './fr'
import { avoventesCrawler } from './fr-avoventes'
import { syslumennCrawler } from './is'
import { ontarioTaxSalesCrawler } from './ca'
import { oksjonikeskusCrawler } from './ee'
import { eizsolesCrawler } from './lv'
import { eLeiloesCrawler } from './pt'
import { sodneDrazbeCrawler } from './si'

/**
 * All registered platform crawlers. Adding a new platform is purely additive:
 * 1. Implement the PlatformCrawler interface in server/crawlers/<name>/.
 * 2. Append it here.
 * Multiple platforms may share the same {country, region} (e.g. the joint
 * Bund-Länder portal + a state-specific portal for one Bundesland). Crawls
 * dispatch to every registered platform for the region and merge results.
 */
export const platforms: readonly PlatformCrawler[] = [
  zvgPortalCrawler,
  boeCrawler,
  zvbawuCrawler,
  mvZvgcomCrawler,
  atEdikteCrawler,
  bidditCrawler,
  agiCrawler,
  plKomornikCrawler,
  czPortaldrazebCrawler,
  mnvCrawler,
  eaukcionaiCrawler,
  pravosudijeCrawler,
  kronofogdenCrawler,
  huutokaupatCrawler,
  tvangsauktionerCrawler,
  licitorCrawler,
  avoventesCrawler,
  syslumennCrawler,
  ontarioTaxSalesCrawler,
  oksjonikeskusCrawler,
  eizsolesCrawler,
  eLeiloesCrawler,
  sodneDrazbeCrawler,
] as const

export interface RegionEntry extends RegionInfo {
  country: string
  /** All platforms that serve this {country, region}. Multiple entries when
   *  several portals overlap (e.g. zvg-portal + zvbawü for Baden-Württemberg). */
  platforms: Array<{ id: string; name: string }>
}

export interface CountryEntry {
  /** ISO 3166-1 alpha-2, lowercase. */
  code: string
  /** Localised display name (German). */
  name: string
  regions: RegionEntry[]
}

const COUNTRY_NAMES: Record<string, string> = {
  de: 'Deutschland',
  at: 'Österreich',
  es: 'Spanien',
  it: 'Italien',
  cz: 'Tschechien',
  pl: 'Polen',
  be: 'Belgien',
  hu: 'Ungarn',
  lt: 'Litauen',
  ba: 'Bosnien-Herzegowina',
  se: 'Schweden',
  fi: 'Finnland',
  dk: 'Dänemark',
  fr: 'Frankreich',
  is: 'Island',
  ca: 'Kanada',
  ee: 'Estland',
  lv: 'Lettland',
  pt: 'Portugal',
  si: 'Slowenien',
}

export function listRegions(): RegionEntry[] {
  const byKey = new Map<string, RegionEntry>()
  for (const p of platforms) {
    for (const r of p.regions) {
      const key = `${p.country}:${r.code}`
      const existing = byKey.get(key)
      if (existing) {
        existing.platforms.push({ id: p.id, name: p.name })
      } else {
        byKey.set(key, {
          ...r,
          country: p.country,
          platforms: [{ id: p.id, name: p.name }],
        })
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.country.localeCompare(b.country) || a.name.localeCompare(b.name, 'de'),
  )
}

export function listCountries(): CountryEntry[] {
  const grouped = new Map<string, RegionEntry[]>()
  for (const r of listRegions()) {
    const arr = grouped.get(r.country) ?? []
    arr.push(r)
    grouped.set(r.country, arr)
  }
  return [...grouped.entries()]
    .map(([code, regions]) => ({
      code,
      name: COUNTRY_NAMES[code] ?? code.toUpperCase(),
      regions,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
}

export function getCrawlersForRegion(country: string, regionCode: string): PlatformCrawler[] {
  const c = country.toLowerCase()
  const r = regionCode.toLowerCase()
  return platforms.filter(
    (p) => p.country === c && p.regions.some((reg) => reg.code === r),
  )
}

/**
 * French judicial-sale sources (licitor.com, avoventes.fr) never publish the
 * court's own case number, so both always have an empty {aktenzeichen}, yet
 * they frequently cross-publish the exact same sale (the same avocat
 * poursuivant submits to both platforms). Fall back to a normalized {postal
 * code, house number, sale date} fingerprint so that pair collapses to one
 * pin instead of showing twice. Scoped to country 'fr' only — other
 * countries with an empty aktenzeichen (AT, EE, LV, FI) have exactly one
 * registered platform each and must keep relying on {platform, zvgId}.
 */
export function frAddressDateKey(a: Auction): string | null {
  if (a.country !== 'fr' || !a.adresse || !a.terminIso) return null
  const postal = a.adresse.match(/\b\d{5}\b/)?.[0]
  if (!postal) return null
  // Strip the postal code before looking for a house number — otherwise a
  // postal-code-only address (no street number, e.g. a rural lieu-dit) would
  // match the postal code itself as "the house number", degenerating to a
  // {postal, postal, date} key that can falsely merge two distinct auctions
  // that only share a postal code and a sale date.
  const addressWithoutPostal = a.adresse.replace(new RegExp(`\\b${postal}\\b`), '')
  const houseNumber = addressWithoutPostal.match(/\b\d+[a-z]?(?:\s*(?:bis|ter|quater))?\b/i)?.[0]
  if (!houseNumber) return null
  return `fr-addr|${postal}|${houseNumber}|${a.terminIso.slice(0, 10)}`
}

/**
 * Rough completeness score used to pick a winner when two platforms publish
 * the same real-world sale. Higher is richer — so when e.g. avoventes.fr has
 * a fuller record for a sale than licitor.com (or vice versa), the fuller one
 * survives instead of whichever platform happens to be registered first.
 */
export function completenessScore(a: Auction): number {
  return (
    (a.verkehrswertEur != null ? 1 : 0) +
    (a.objekt ? 1 : 0) +
    (a.adresse ? 1 : 0) +
    (a.terminIso ? 1 : 0) +
    (a.beschreibung ? 1 : 0) +
    Math.min(a.fotoCount, 5)
  )
}

/**
 * Crawl one region via every platform that owns it. When multiple platforms
 * cover the same {country, region}, their results are merged into a single
 * CrawlResult. Per-platform failures are logged but do not abort the whole
 * region (the surviving platforms' auctions are still returned).
 */
export async function crawlSingle(
  opts: CrawlOptions & { country: string },
): Promise<CrawlResult> {
  const crawlers = getCrawlersForRegion(opts.country, opts.region)
  if (crawlers.length === 0) {
    throw new Error(
      `Kein Crawler für ${opts.country}/${opts.region} registriert`,
    )
  }
  const settled = await Promise.allSettled(crawlers.map((c) => c.crawl(opts)))
  const results: CrawlResult[] = []
  for (const [i, s] of settled.entries()) {
    if (s.status === 'fulfilled') {
      results.push(s.value)
    } else {
      console.warn(
        `[crawlSingle] ${opts.country}/${opts.region} via ${crawlers[i]?.id}: ${(s.reason as Error).message}`,
      )
    }
  }
  if (results.length === 0) {
    // Every platform failed — surface the first error so the API layer can
    // decide whether it's a rate-limit (graceful degrade) or a real outage.
    const firstReject = settled.find((s) => s.status === 'rejected')
    throw firstReject ? (firstReject as PromiseRejectedResult).reason : new Error('all crawlers failed')
  }
  // Overlapping platforms (e.g. zvg-portal + zvbawü both list the same BW
  // property) would otherwise produce duplicate pins and list rows. Dedup by
  // a normalized {amtsgericht, aktenzeichen} key — the Aktenzeichen is the
  // court's own case number and is stable across portals. Among auctions
  // sharing a key, keep the one with the richer record (completenessScore)
  // rather than whichever platform happens to be registered/crawled first.
  const azWinners = new Map<string, Auction>()
  const pfSeen = new Set<string>()
  const noAzAuctions: Auction[] = []
  for (const a of results.flatMap((r) => r.auctions)) {
    const az = a.aktenzeichen.trim().toLowerCase().replace(/\s+/g, ' ')
    const ag = a.amtsgericht.trim().toLowerCase()
    if (az && ag) {
      const key = `az|${ag}|${az}`
      const existing = azWinners.get(key)
      if (!existing || completenessScore(a) > completenessScore(existing)) {
        azWinners.set(key, a)
      }
      continue
    }
    // No court case number available — {platform, zvgId} is checked
    // unconditionally so platform-internal uniqueness is always preserved,
    // independently of the cross-platform address+date matching below.
    const pfKey = `pf|${a.platform}|${a.zvgId}`
    if (pfSeen.has(pfKey)) continue
    pfSeen.add(pfKey)
    noAzAuctions.push(a)
  }

  // French judicial-sale sources never publish the court's own case number,
  // yet frequently cross-publish the exact same sale — collapse auctions
  // sharing a {postal code, house number, date} fingerprint (frAddressDateKey)
  // to whichever has the richer record, but ONLY across different platforms.
  // Two same-platform auctions sharing that fingerprint are distinct lots
  // (e.g. two apartments in one seized building sold the same day) and must
  // both survive — grouping by platform first guards that.
  const addrGroups = new Map<string, Auction[]>()
  const auctions: Auction[] = []
  for (const a of noAzAuctions) {
    const key = frAddressDateKey(a)
    if (!key) {
      auctions.push(a)
      continue
    }
    const group = addrGroups.get(key)
    if (group) group.push(a)
    else addrGroups.set(key, [a])
  }
  for (const group of addrGroups.values()) {
    if (new Set(group.map((a) => a.platform)).size === 1) {
      auctions.push(...group)
    } else {
      auctions.push(group.reduce((best, a) => (completenessScore(a) > completenessScore(best) ? a : best)))
    }
  }
  auctions.push(...azWinners.values())
  return {
    platform: results.length === 1 ? (results[0] as CrawlResult).platform : 'multi',
    source: [...new Set(results.map((r) => r.source))].join(', '),
    countries: [opts.country],
    regions: [...new Set(results.flatMap((r) => r.regions))],
    fetchedAt: new Date().toISOString(),
    totalReported: results.reduce<number | null>(
      (sum, r) => (r.totalReported == null ? sum : (sum ?? 0) + r.totalReported),
      null,
    ),
    auctions,
  }
}

export interface CrawlAllOptions {
  immobilienOnly?: boolean
  enrichDetails?: boolean
  /** Restrict to one country (ISO-2). Omit/null = all registered countries. */
  country?: string | null
  /** Max parallel region fetches across all platforms. */
  regionConcurrency?: number
}

/**
 * Crawl every registered region (optionally filtered to one country) and merge
 * into one result.
 *
 * Concurrency: regions run in parallel up to `regionConcurrency`. Inside a
 * crawler, the implementation does its own detail-fetch concurrency. Failures
 * in individual regions don't abort the whole run — they show up as zero
 * auctions for that region and are returned in `errors`.
 */
export async function crawlAll(
  opts: CrawlAllOptions = {},
): Promise<CrawlResult & { errors: { country: string; region: string; message: string }[] }> {
  const concurrency = opts.regionConcurrency ?? 4
  const all = listRegions().filter(
    (r) => !opts.country || r.country === opts.country.toLowerCase(),
  )
  const results: CrawlResult[] = []
  const errors: { country: string; region: string; message: string }[] = []

  let cursor = 0
  async function worker() {
    while (cursor < all.length) {
      const idx = cursor++
      const r = all[idx]
      if (!r) continue
      try {
        const result = await crawlSingle({
          country: r.country,
          region: r.code,
          immobilienOnly: opts.immobilienOnly,
          enrichDetails: opts.enrichDetails,
        })
        results.push(result)
      } catch (err) {
        errors.push({
          country: r.country,
          region: r.code,
          message: (err as Error).message,
        })
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))

  const merged = results.flatMap((r) => r.auctions)
  const totalReported = results.reduce<number | null>(
    (sum, r) => (r.totalReported == null ? sum : (sum ?? 0) + r.totalReported),
    null,
  )

  return {
    platform: 'multi',
    source: [...new Set(results.map((r) => r.source))].join(', '),
    // Reflect the requested scope, not just the successful subset — failed
    // regions still belong to the run and reappear in `errors`.
    countries: [...new Set(all.map((r) => r.country))],
    regions: [...new Set(all.map((r) => r.name))],
    fetchedAt: new Date().toISOString(),
    totalReported,
    auctions: merged,
    errors,
  }
}
