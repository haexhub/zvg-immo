import type {
  DataSourceAttribution,
  LocationAmenityKind,
  NearbyPlaceKind,
} from '~/types/auction'
import { minOf } from '~/lib/array-math'
import { distanceMeters, type Point } from './geo'

export interface OverpassResponse {
  elements?: OsmElement[]
  /** Set instead of an error status when a query dies server-side. */
  remark?: string
}

export interface OsmElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat?: number; lon?: number }
  tags?: Record<string, string>
}

export type LocatedElement = OsmElement & { point: Point; distanceMeters: number }

export const SOURCE: DataSourceAttribution = {
  id: 'openstreetmap-overpass',
  label: 'OpenStreetMap / Overpass',
  url: 'https://www.openstreetmap.org/copyright',
  licenseNote: 'OpenStreetMap data is available under the Open Database License; coverage and tag quality vary by region.',
}

export const PLACE_KINDS = new Set<NearbyPlaceKind>([
  'city',
  'town',
  'suburb',
  'village',
  'hamlet',
  'island',
  'municipality',
])

export const MAJOR_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary'])
export const NOISY_ROADS = new Set(['motorway', 'trunk', 'primary'])
export const INDUSTRIAL_LANDUSE = new Set(['industrial', 'quarry', 'landfill', 'brownfield'])
export const COMMERCIAL_LANDUSE = new Set(['commercial', 'retail'])
export const HEAVY_INDUSTRY_TAGS = new Set([
  'works',
  'factory',
  'plant',
  'power',
  'power_plant',
  'wastewater_plant',
  'incinerator',
  'quarry',
  'mine',
  'landfill',
  'petroleum_well',
  'mineshaft',
  'generator',
  'substation',
])
export const BUILDING_RADIUS_METERS = 500
export const BUILDING_RADIUS_SQ_KM = Math.PI * (BUILDING_RADIUS_METERS / 1000) ** 2
export const PLACE_RADIUS_METERS = 30_000
export const FERRY_RADIUS_METERS = 10_000
export const HEAVY_INDUSTRY_RADIUS_METERS = 5_000
export const AMENITY_KINDS: LocationAmenityKind[] = [
  'groceries',
  'education',
  'healthcare',
  'hospital',
  'pharmacy',
  'banking',
  'fuel',
  'food',
  'restaurant',
  'cafe',
  'leisure',
  'recreation',
]

export function locateElement(origin: Point, element: OsmElement): LocatedElement | null {
  const lat = element.lat ?? element.center?.lat
  const lng = element.lon ?? element.center?.lon
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const point = { lat: lat!, lng: lng! }
  return { ...element, point, distanceMeters: Math.round(distanceMeters(origin, point)) }
}

export function nearestDistance(elements: LocatedElement[]): number | null {
  if (elements.length === 0) return null
  return minOf(elements.map((element) => element.distanceMeters))
}

export function uniqueLocated(elements: LocatedElement[]): LocatedElement[] {
  const seen = new Set<string>()
  const out: LocatedElement[] = []
  for (const element of elements) {
    const key = `${element.type}:${element.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(element)
  }
  return out
}

export function nameOf(element: OsmElement): string {
  return (element.tags?.name ?? element.tags?.['name:de'] ?? element.tags?.['name:en'] ?? '').trim()
}

export function placeKind(value: string | undefined): NearbyPlaceKind {
  return value && PLACE_KINDS.has(value as NearbyPlaceKind) ? value as NearbyPlaceKind : 'unknown'
}

export function hasTag(key: string, value: string): (element: LocatedElement) => boolean {
  return (element) => element.tags?.[key] === value
}
