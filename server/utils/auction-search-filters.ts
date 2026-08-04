// Shared WHERE-clause builder for the two public search endpoints:
// /api/auctions (paginated cards) and /api/auctions-geo (markers only). Both
// must agree exactly — a marker the list cannot show, or a card missing from
// the map, reads to the user as a broken filter — so the predicate lives here
// once instead of being copied per endpoint.

import type { Pool } from 'pg'
import { ensureEnabledCountriesLoaded, getEnabledCountryCodes } from '~/server/crawlers/registry'
import { getHideRulesOnlyAuctions } from '~/server/utils/app-settings'
import { proximityConditionAnyOf, proximityConditionAnyTag, type ProximityTagMatcher } from '~/server/utils/osm-proximity'

// Umgebung ("environment") proximity filters — same osm_local_elements
// dataset and EXISTS/ST_DWithin shape as the landing page's geo rails
// (server/api/landing/rails.get.ts), but with a user-chosen radius instead
// of a fixed one. Query param name -> OSM tag matchers.
interface ProximityFilterConfig {
  matchers: ProximityTagMatcher[]
  constrainCountry?: boolean
}

const PROXIMITY_FILTERS: Record<string, ProximityFilterConfig> = {
  // Coastal OSM imports are not always represented only by
  // natural=coastline, especially around islands. Do not constrain the OSM
  // element's country here either: coastline/bay/sea geometries often sit on
  // borders or water and the user's selected auction country already scopes
  // the candidates.
  nearSea: {
    constrainCountry: false,
    matchers: [
      { tagKey: 'natural', tagValue: 'coastline' },
      { tagKey: 'natural', tagValue: 'beach' },
      { tagKey: 'natural', tagValue: 'bay' },
      { tagKey: 'natural', tagValue: 'strait' },
      { tagKey: 'water', tagValue: 'sea' },
      { tagKey: 'water', tagValue: 'lagoon' },
      { tagKey: 'place', tagValue: 'sea' },
      { tagKey: 'place', tagValue: 'ocean' },
    ],
  },
  nearLake: { matchers: [{ tagKey: 'natural', tagValue: 'water' }] },
  nearRiver: { matchers: [{ tagKey: 'waterway', tagValue: 'river' }] },
  nearMountain: { matchers: [{ tagKey: 'natural', tagValue: 'peak' }] },
  nearAirport: { matchers: [{ tagKey: 'aeroway', tagValue: 'aerodrome' }] },
}

// A settlement counts as "urban" if a city/town-sized OSM place node sits
// within this radius; otherwise the auction is "rural". Arbitrary but easy
// to retune later — there's no existing urban/rural concept in this codebase
// to anchor to.
const URBAN_PLACE_TAGS = ['city', 'town']
const URBAN_RADIUS_METERS = 5_000

export interface AuctionSearchFilter {
  /** `WHERE …`, or '' when nothing is constrained. */
  predicate: string
  /** Positional parameters for `predicate`, starting at $1. */
  values: unknown[]
}

export function commaList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '')
  return [...new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean))]
}

/** '' must yield null, not Number('') === 0 — callers use null to mean "unset". */
export function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(Array.isArray(value) ? value[0] : value)
  return Number.isFinite(parsed) ? parsed : null
}

export async function buildAuctionSearchFilter(
  db: Pool,
  query: Record<string, unknown>,
): Promise<AuctionSearchFilter> {
  const values: unknown[] = []
  const where: string[] = []
  const add = (value: unknown): string => {
    values.push(value)
    return `$${values.length}`
  }

  // A paused country keeps its raw data, history, watchlists and permalinks but
  // must stop surfacing in discovery (see server/crawlers/registry.ts). The
  // serving tables are never pruned on pause, so the enabled set has to be
  // applied here — unlike the list caches this replaced, which filtered on read.
  await ensureEnabledCountriesLoaded()
  const enabled = getEnabledCountryCodes()
  const requested = commaList(query.country)
    .filter((entry) => /^[a-z]{2}$/i.test(entry))
    .map((entry) => entry.toLowerCase())
  const countries = requested.length ? requested.filter((entry) => enabled.includes(entry)) : enabled
  where.push(`a.country = ANY(${add(countries)}::text[])`)

  // `auctions` is upserted row-by-row (current-auctions.ts) and never pruned,
  // so an auction whose date has passed keeps its row indefinitely once the
  // crawl stops returning it — unlike list_cache, which replaced the whole
  // region blob per crawl and so dropped concluded auctions for free. Filter
  // it here instead, the same way the enabled-country scope above is applied
  // at read time rather than by deleting rows.
  where.push(`(a.auction_date_iso IS NULL OR a.auction_date_iso >= now())`)

  const regionNames = commaList(query.regionNames)
  if (regionNames.length) where.push(`(a.country || ':' || a.region) = ANY(${add(regionNames)}::text[])`)

  const search = String(query.q ?? '').trim()
  if (search) {
    where.push(`concat_ws(' ', a.case_number, a.authority, a.title, d.address, d.description) ILIKE ${add(`%${search}%`)}`)
  }
  const authority = String(query.authority ?? '')
  if (authority && authority !== 'all') where.push(`a.authority = ${add(authority)}`)
  const category = String(query.category ?? '')
  if (category && category !== 'all') where.push(`d.property_type = ${add(category)}`)
  // Comma-list (not a single exact match) so the landing page's "best
  // maintained" rail can ask for multiple condition tiers at once
  // (neuwertig,gepflegt) — pages/search.vue's single-select UI still works
  // unchanged since commaList('x') === ['x'].
  const conditions = commaList(query.condition).filter((entry) => entry !== 'all')
  if (conditions.length) where.push(`d.condition #>> '{}' = ANY(${add(conditions)}::text[])`)
  const features = commaList(query.features)
  if (features.length) where.push(`d.features && ${add(features)}::text[]`)
  if (String(query.photos ?? '') === '1') where.push('d.photo_count > 0')
  if (String(query.cancelled ?? '') !== '1') where.push('a.cancelled = false')

  // pages/search.vue only puts llmOnly in the URL when the user overrode the
  // admin-configured default (/api/display-settings), so an absent parameter
  // means "use that default" — not "no filter".
  const llmOnlyParam = String(query.llmOnly ?? '')
  const hideRulesOnly = llmOnlyParam === '1'
    ? true
    : llmOnlyParam === '0'
      ? false
      : await getHideRulesOnlyAuctions(db)
  if (hideRulesOnly) {
    // The jsonb columns keep AuctionExtraction's "never checked" (SQL NULL)
    // vs "checked, found nothing" (jsonb null) distinction, so IS NOT NULL
    // here means the same as the `? 'condition'` key-existence test it
    // replaces (see auction-details.ts's json()).
    where.push(`(
      d.extraction_source = 'llm'
      OR d.llm_analyzed_at IS NOT NULL
      OR d.condition IS NOT NULL
      OR d.features IS NOT NULL
      OR d.insights IS NOT NULL
    )`)
  }

  const ranges: Array<[unknown, string, '>=' | '<=']> = [
    [query.priceMin, 'd.market_value_eur', '>='],
    [query.priceMax, 'd.market_value_eur', '<='],
    [query.landMin, 'd.land_area_sqm', '>='],
    [query.landMax, 'd.land_area_sqm', '<='],
    [query.livMin, 'd.living_area_sqm', '>='],
    [query.livMax, 'd.living_area_sqm', '<='],
    [query.yearBuiltMin, 'd.year_built', '>='],
    [query.yearBuiltMax, 'd.year_built', '<='],
    [query.renovationYearMin, 'd.last_renovation_year', '>='],
    [query.renovationYearMax, 'd.last_renovation_year', '<='],
  ]
  for (const [raw, column, operator] of ranges) {
    const value = finiteNumber(raw)
    if (value != null) where.push(`${column} ${operator} ${add(value)}`)
  }

  for (const [param, config] of Object.entries(PROXIMITY_FILTERS)) {
    const km = finiteNumber(query[param])
    if (km != null && km > 0) {
      where.push(proximityConditionAnyTag(config.matchers, km * 1000, add, {
        constrainCountry: config.constrainCountry,
      }))
    }
  }

  const urbanRural = String(query.urbanRural ?? '')
  if (urbanRural === 'urban' || urbanRural === 'rural') {
    const nearCity = proximityConditionAnyOf('place', URBAN_PLACE_TAGS, URBAN_RADIUS_METERS, add)
    where.push(urbanRural === 'urban' ? nearCity : `NOT (${nearCity})`)
  }

  // "Immobilien in der Nähe" — the user's own browser-geolocated position,
  // filtered directly against the auction's own geocoded coordinates. No OSM
  // data involved, so it works everywhere an auction already has lat/lng.
  const nearLat = finiteNumber(query.nearLat)
  const nearLng = finiteNumber(query.nearLng)
  const nearRadiusKm = finiteNumber(query.nearRadius)
  if (nearLat != null && nearLng != null && nearRadiusKm != null && nearRadiusKm > 0) {
    where.push(`a.lat IS NOT NULL AND a.lng IS NOT NULL AND ST_DWithin(
      ST_MakePoint(a.lng, a.lat)::geography,
      ST_MakePoint(${add(nearLng)}, ${add(nearLat)})::geography,
      ${add(nearRadiusKm * 1000)}
    )`)
  }

  return { predicate: where.length ? `WHERE ${where.join(' AND ')}` : '', values }
}
