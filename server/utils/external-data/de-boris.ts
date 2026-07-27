import type { Auction, LandValueBaseline } from '~/types/auction'
import { distanceMeters } from './geo'
import { EXTERNAL_DATA_SOURCES } from './sources'

export interface BorisLandValueZone {
  id: string
  label: string | null
  lat: number
  lng: number
  valueEurPerSqm: number
  regionLabel: string
  sourceUpdatedAt?: string | null
}

export interface BorisBaselineOptions {
  maxDistanceMeters?: number
  checkedAt?: string
}

const DEFAULT_MAX_DISTANCE_METERS = 2_000
const BORIS_SOURCE = EXTERNAL_DATA_SOURCES.find((source) => source.id === 'de-boris-d')!

export function buildBorisLandValueBaseline(
  auction: Auction,
  zones: BorisLandValueZone[],
  options: BorisBaselineOptions = {},
): LandValueBaseline | null {
  if (auction.country !== 'de') return null
  if (auction.lat == null || auction.lng == null) return null
  const maxDistanceMeters = options.maxDistanceMeters ?? DEFAULT_MAX_DISTANCE_METERS
  const nearest = zones
    .map((zone) => ({
      zone,
      distance: distanceMeters({ lat: auction.lat!, lng: auction.lng! }, zone),
    }))
    .filter((hit) => hit.zone.valueEurPerSqm > 0 && hit.distance <= maxDistanceMeters)
    .sort((a, b) => a.distance - b.distance)[0]
  if (!nearest) return null

  return {
    valueEurPerSqm: nearest.zone.valueEurPerSqm,
    regionLabel: nearest.zone.regionLabel,
    zoneLabel: nearest.zone.label,
    distanceMeters: nearest.distance,
    checkedAt: options.checkedAt ?? new Date().toISOString(),
    source: {
      id: BORIS_SOURCE.id,
      label: BORIS_SOURCE.label,
      url: BORIS_SOURCE.sourceUrl,
      licenseNote: BORIS_SOURCE.licenseNote,
    },
  }
}
