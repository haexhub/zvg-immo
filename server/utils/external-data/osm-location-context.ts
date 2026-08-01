import type { Pool } from 'pg'
import type { Auction } from '~/types/auction'
import type { LocationContextAdapter } from '~/server/tasks/external-enrichment'
import { type Point } from './geo'
import { buildLocationContext } from './osm-location-context-builder'
import {
  BUILDING_RADIUS_METERS,
  FERRY_RADIUS_METERS,
  HEAVY_INDUSTRY_RADIUS_METERS,
  PLACE_RADIUS_METERS,
  type OsmElement,
} from './osm-location-shared'

export { buildLocationContext }

const NOISY_ROAD_RADIUS_METERS = 8_000
const MINOR_ROAD_RADIUS_METERS = 5_000
const OFFICE_RADIUS_METERS = 1_500

interface OsmCategory {
  radiusMeters: number
  tagKey: string
  /** Omitted means "key exists, any value" — Overpass QL's bare `["key"]` filter. */
  values?: string[]
  /** Mirrors the old query's `node(...)` (vs `nwr(...)`) selector — the
   *  nwr variant dragged in administrative boundary *relations* that also
   *  carry a `place`/`highway` tag, e.g. a city's boundary polygon reporting
   *  itself as a "nearby place" a few metres away. */
  nodeOnly?: boolean
}

// Mirrors the old buildQuery()'s Overpass QL sub-clauses one-for-one — same
// tag/value sets, same radii — just run as local bbox-indexed queries against
// osm_local_elements instead of a remote POST. Keep in sync with
// osm-location-context-builder.ts's own consumption: categories it doesn't
// re-clip by exact distance (roads, aeroway, industrial/commercial/office/
// building/university/school) need to stay close to their real radius here,
// since nothing downstream narrows them further.
const CATEGORIES: OsmCategory[] = [
  { radiusMeters: PLACE_RADIUS_METERS, tagKey: 'place', values: ['city', 'town', 'suburb', 'village', 'hamlet', 'island', 'municipality'], nodeOnly: true },
  { radiusMeters: 3000, tagKey: 'public_transport', values: ['platform', 'stop_position', 'station'] },
  { radiusMeters: 3000, tagKey: 'highway', values: ['bus_stop'], nodeOnly: true },
  { radiusMeters: 3000, tagKey: 'railway', values: ['station', 'halt', 'tram_stop'] },
  { radiusMeters: FERRY_RADIUS_METERS, tagKey: 'amenity', values: ['ferry_terminal'] },
  { radiusMeters: FERRY_RADIUS_METERS, tagKey: 'route', values: ['ferry'] },
  { radiusMeters: 15000, tagKey: 'aeroway', values: ['aerodrome', 'runway', 'helipad', 'heliport'] },
  { radiusMeters: NOISY_ROAD_RADIUS_METERS, tagKey: 'highway', values: ['motorway', 'trunk', 'primary'] },
  { radiusMeters: MINOR_ROAD_RADIUS_METERS, tagKey: 'highway', values: ['secondary', 'tertiary'] },
  { radiusMeters: 5000, tagKey: 'landuse', values: ['industrial', 'commercial', 'retail', 'quarry', 'landfill', 'brownfield'] },
  { radiusMeters: HEAVY_INDUSTRY_RADIUS_METERS, tagKey: 'industrial' },
  { radiusMeters: HEAVY_INDUSTRY_RADIUS_METERS, tagKey: 'man_made', values: ['works', 'wastewater_plant', 'petroleum_well', 'mineshaft'] },
  { radiusMeters: HEAVY_INDUSTRY_RADIUS_METERS, tagKey: 'power', values: ['plant', 'generator', 'substation'] },
  { radiusMeters: 5000, tagKey: 'amenity', values: ['waste_transfer_station', 'recycling', 'ferry_terminal'] },
  { radiusMeters: 10000, tagKey: 'amenity', values: ['college', 'university'] },
  { radiusMeters: OFFICE_RADIUS_METERS, tagKey: 'office' },
  { radiusMeters: BUILDING_RADIUS_METERS, tagKey: 'building' },
  { radiusMeters: 5000, tagKey: 'amenity', values: ['school', 'kindergarten', 'college', 'university', 'doctors', 'clinic', 'hospital', 'pharmacy', 'bank', 'atm', 'fuel', 'restaurant', 'cafe', 'bar', 'fast_food', 'post_office', 'library', 'community_centre'] },
  { radiusMeters: 5000, tagKey: 'shop', values: ['supermarket', 'convenience', 'bakery', 'butcher', 'mall', 'department_store'] },
  { radiusMeters: 5000, tagKey: 'leisure', values: ['park', 'sports_centre', 'playground', 'fitness_centre', 'garden'] },
  { radiusMeters: 500, tagKey: 'abandoned' },
  { radiusMeters: 500, tagKey: 'disused' },
  { radiusMeters: 500, tagKey: 'ruins' },
  { radiusMeters: 500, tagKey: 'building', values: ['ruins', 'collapsed', 'abandoned'] },
  { radiusMeters: 500, tagKey: 'historic', values: ['ruins'] },
]

interface LocalOsmRow {
  osm_type: 'node' | 'way' | 'relation'
  osm_id: string
  lat: number
  lon: number
  tags: Record<string, string>
}

async function queryCategory(db: Pool, country: string, point: Point, category: OsmCategory): Promise<OsmElement[]> {
  const tagCondition = category.values ? `tags ->> $5 = ANY($6::text[])` : `tags ? $5`
  const params: unknown[] = [country, point.lng, point.lat, category.radiusMeters, category.tagKey]
  if (category.values) params.push(category.values)
  const { rows } = await db.query<LocalOsmRow>(
    `
    SELECT osm_type, osm_id::text AS osm_id, tags,
           ST_Y(ST_PointOnSurface(geom)) AS lat, ST_X(ST_PointOnSurface(geom)) AS lon
    FROM osm_local_elements
    WHERE country = $1
      AND ST_DWithin(geom::geography, ST_MakePoint($2, $3)::geography, $4)
      AND ${tagCondition}
      ${category.nodeOnly ? "AND osm_type = 'node'" : ''}
    `,
    params,
  )
  return rows.map((row) => ({
    type: row.osm_type,
    id: Number(row.osm_id),
    lat: row.lat,
    lon: row.lon,
    tags: row.tags,
  }))
}

async function hasAnyDataFor(db: Pool, country: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM osm_local_elements WHERE country = $1) AS exists',
    [country],
  )
  return rows[0]?.exists ?? false
}

export interface LocalOsmLocationContextOptions {
  db: Pool
  checkedAt: string
}

/** Local replacement for the old live-Overpass adapter: queries a PostGIS
 *  table (osm_local_elements) loaded out-of-band by a standalone osm2pgsql
 *  job instead of POSTing to the public overpass-api.de, which started
 *  timing out under the nightly full-dataset external-enrichment run. Same
 *  tag/radius categories, same buildLocationContext scoring — only the fetch
 *  mechanics changed. No retry/backoff/rate-gate needed: it's an indexed
 *  local query, not a rate-limited remote API. */
export function createLocalOsmLocationContextAdapter(options: LocalOsmLocationContextOptions): LocationContextAdapter {
  // One check per country per adapter instance (i.e. per run) instead of per
  // auction — external-enrichment.ts builds this adapter once and walks
  // thousands of auctions through it, nearly all sharing a handful of
  // countries.
  const coveredCountries = new Map<string, Promise<boolean>>()
  const isCovered = (country: string) => {
    let covered = coveredCountries.get(country)
    if (!covered) {
      covered = hasAnyDataFor(options.db, country)
      coveredCountries.set(country, covered)
    }
    return covered
  }

  return {
    id: 'osm-location-context-local',
    sourceVersion: 'osm-local-v1',
    supports: (auction) => isFinitePoint(auction),
    async context(auction) {
      const country = auction.country.toLowerCase()
      // A country with zero imported rows means "not loaded yet", not
      // "genuinely nothing nearby" — returning null here (instead of a
      // context built from an empty element set) keeps that distinction
      // instead of caching a misleadingly featureless LocationContext.
      if (!(await isCovered(country))) return null
      const point = { lat: auction.lat!, lng: auction.lng! }
      const results = await Promise.all(
        CATEGORIES.map((category) => queryCategory(options.db, country, point, category)),
      )
      return buildLocationContext(point, dedupe(results.flat()), options.checkedAt)
    },
  }
}

function dedupe(elements: OsmElement[]): OsmElement[] {
  const seen = new Set<string>()
  const out: OsmElement[] = []
  for (const element of elements) {
    const key = `${element.type}:${element.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(element)
  }
  return out
}

function isFinitePoint(auction: Auction): boolean {
  return Number.isFinite(auction.lat) && Number.isFinite(auction.lng)
}
