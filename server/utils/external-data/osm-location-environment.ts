import type { LocationEnvironmentContext } from '~/types/auction'
import {
  COMMERCIAL_LANDUSE,
  HEAVY_INDUSTRY_TAGS,
  INDUSTRIAL_LANDUSE,
  nameOf,
  nearestDistance,
  uniqueLocated,
  type LocatedElement,
} from './osm-location-shared'

export function environmentContext(
  industrialElements: LocatedElement[],
  commercialElements: LocatedElement[],
  heavyIndustryElements: LocatedElement[],
  noisyRoadElements: LocatedElement[],
  aviation: {
    airportElements: LocatedElement[]
    runwayElements: LocatedElement[]
    helipadElements: LocatedElement[]
  },
): LocationEnvironmentContext {
  const motorwayElements = noisyRoadElements.filter((element) => element.tags?.highway === 'motorway' || element.tags?.highway === 'trunk')
  const primaryRoadElements = noisyRoadElements.filter((element) => element.tags?.highway === 'primary')
  const nearestMotorway = nearestDistance(motorwayElements)
  const nearestPrimary = nearestDistance(primaryRoadElements)
  const riskSignals: string[] = []
  if (nearestMotorway != null && nearestMotorway <= 1000) riskSignals.push('motorway_very_near')
  else if (nearestMotorway != null && nearestMotorway <= 2500) riskSignals.push('motorway_near')
  if (nearestPrimary != null && nearestPrimary <= 500) riskSignals.push('primary_road_very_near')
  const nearestAirport = nearestDistance(aviation.airportElements)
  const nearestRunway = nearestDistance(aviation.runwayElements)
  const nearestHelipad = nearestDistance(aviation.helipadElements)
  if (nearestRunway != null && nearestRunway <= 3000) riskSignals.push('runway_very_near')
  else if (nearestRunway != null && nearestRunway <= 8000) riskSignals.push('runway_near')
  if (nearestAirport != null && nearestAirport <= 5000) riskSignals.push('airport_near')
  if (nearestHelipad != null && nearestHelipad <= 1000) riskSignals.push('helipad_near')
  if (nearestDistance(heavyIndustryElements) != null) riskSignals.push('heavy_industry_mapped')
  if (industrialElements.some((element) => element.distanceMeters <= 1000)) riskSignals.push('industrial_area_nearby')

  const nearestAirportElement = [...aviation.airportElements].sort((a, b) => a.distanceMeters - b.distanceMeters)[0] ?? null

  return {
    industrialCountWithin1000m: industrialElements.filter((element) => element.distanceMeters <= 1000).length,
    industrialCountWithin3000m: industrialElements.filter((element) => element.distanceMeters <= 3000).length,
    commercialCountWithin1000m: commercialElements.filter((element) => element.distanceMeters <= 1000).length,
    commercialCountWithin3000m: commercialElements.filter((element) => element.distanceMeters <= 3000).length,
    nearestIndustrialDistanceMeters: nearestDistance(industrialElements),
    nearestCommercialDistanceMeters: nearestDistance(commercialElements),
    nearestHeavyIndustryDistanceMeters: nearestDistance(heavyIndustryElements),
    heavyIndustryKinds: [...new Set(heavyIndustryElements.flatMap(heavyIndustryKinds))].sort(),
    heavyIndustrySites: industrialSites(industrialElements, heavyIndustryElements),
    noisyRoadLevel: noisyRoadLevel(nearestMotorway, nearestPrimary),
    aviationNoiseLevel: aviationNoiseLevel(nearestAirport, nearestRunway, nearestHelipad),
    nearestMotorwayDistanceMeters: nearestMotorway,
    nearestPrimaryRoadDistanceMeters: nearestPrimary,
    nearestAirportDistanceMeters: nearestAirport,
    nearestRunwayDistanceMeters: nearestRunway,
    nearestHelipadDistanceMeters: nearestHelipad,
    nearestAirportName: nearestAirportElement ? nameOf(nearestAirportElement) || null : null,
    nearestAirportKind: airportKind(nearestAirportElement),
    reportedNoise: [],
    airQuality: null,
    riskSignals,
  }
}

/** Named, kind-specific nearby industrial/heavy-industry sites for display —
 *  separate from isHeavyIndustry()'s coarse existence gate (used for scoring),
 *  so an unremarkable `landuse=industrial` polygon and a `plant:source=nuclear`
 *  power plant aren't collapsed into the same generic "industry nearby" text. */
function industrialSites(
  industrialElements: LocatedElement[],
  heavyIndustryElements: LocatedElement[],
): LocationEnvironmentContext['heavyIndustrySites'] {
  return uniqueLocated([...heavyIndustryElements, ...industrialElements])
    .filter((element) => element.distanceMeters <= 3000)
    .map((element) => ({
      kind: industrialSiteKind(element),
      name: nameOf(element) || null,
      distanceMeters: element.distanceMeters,
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, 5)
}

/** Best-effort specific facility type from raw OSM tags, e.g.
 *  `power_plant_nuclear` or `industrial_chemical` — unlike heavyIndustryKinds()
 *  this isn't gated by HEAVY_INDUSTRY_TAGS, so it also names industrial
 *  subtypes (chemical plants, paper mills, ...) that aren't scored as "heavy". */
function industrialSiteKind(element: LocatedElement): string {
  const tags = element.tags ?? {}
  if (tags.power === 'plant') return tags['plant:source'] ? `power_plant_${tags['plant:source']}` : 'power_plant'
  if (tags.power === 'generator') return tags['generator:source'] ? `power_generator_${tags['generator:source']}` : 'power_generator'
  if (tags.power) return `power_${tags.power}`
  // industrial=* (e.g. chemical, food, brewery) is checked before man_made=*
  // because it is the more specific of the two when both are tagged — e.g. a
  // site tagged man_made=works + industrial=chemical is a chemical plant, not
  // an unspecified "works" site.
  if (tags.industrial) return `industrial_${tags.industrial}`
  if (tags.man_made) return `man_made_${tags.man_made}`
  if (tags.amenity === 'waste_transfer_station' || tags.amenity === 'recycling') return `amenity_${tags.amenity}`
  if (tags.landuse === 'quarry' || tags.landuse === 'landfill') return `landuse_${tags.landuse}`
  return 'unspecified'
}

/** Airport size/traffic classification from OSM aerodrome tags: an IATA/ICAO
 *  code signals scheduled commercial service, `aerodrome:type=international`
 *  a major hub, and a military tag overrides both — the distinction between a
 *  glider strip and a hub like Frankfurt that pure distance can't express. */
function airportKind(element: LocatedElement | null): LocationEnvironmentContext['nearestAirportKind'] {
  if (!element) return 'unknown'
  const tags = element.tags ?? {}
  const type = tags['aerodrome:type']
  if (tags.military === 'airfield' || type === 'military') return 'military'
  if (type === 'international') return 'major'
  if (tags.iata || tags.icao || type === 'regional' || type === 'public') return 'regional'
  return 'minor'
}

function noisyRoadLevel(
  nearestMotorway: number | null,
  nearestPrimary: number | null,
): LocationEnvironmentContext['noisyRoadLevel'] {
  if ((nearestMotorway != null && nearestMotorway <= 1000) || (nearestPrimary != null && nearestPrimary <= 250)) return 'high'
  if ((nearestMotorway != null && nearestMotorway <= 2500) || (nearestPrimary != null && nearestPrimary <= 750)) return 'medium'
  return 'low'
}

function aviationNoiseLevel(
  nearestAirport: number | null,
  nearestRunway: number | null,
  nearestHelipad: number | null,
): LocationEnvironmentContext['aviationNoiseLevel'] {
  if ((nearestRunway != null && nearestRunway <= 3000) || (nearestAirport != null && nearestAirport <= 3000)) return 'high'
  if ((nearestRunway != null && nearestRunway <= 8000) || (nearestAirport != null && nearestAirport <= 8000) || (nearestHelipad != null && nearestHelipad <= 1000)) return 'medium'
  return 'low'
}

export function isIndustrial(element: LocatedElement): boolean {
  const landuse = element.tags?.landuse
  return (landuse != null && INDUSTRIAL_LANDUSE.has(landuse)) || element.tags?.industrial != null
}

export function isCommercial(element: LocatedElement): boolean {
  const landuse = element.tags?.landuse
  return (landuse != null && COMMERCIAL_LANDUSE.has(landuse)) || element.tags?.office != null
}

export function isHeavyIndustry(element: LocatedElement): boolean {
  return heavyIndustryKinds(element).length > 0
}

function heavyIndustryKinds(element: LocatedElement): string[] {
  const out = [
    element.tags?.industrial,
    element.tags?.man_made,
    element.tags?.power === 'plant' ? 'power_plant' : element.tags?.power,
    element.tags?.amenity === 'waste_transfer_station' || element.tags?.amenity === 'recycling' ? element.tags.amenity : undefined,
    element.tags?.landuse === 'quarry' || element.tags?.landuse === 'landfill' ? element.tags.landuse : undefined,
  ].filter((value): value is string => !!value)
  return out.filter((value) => HEAVY_INDUSTRY_TAGS.has(value))
}

export function isUniversity(element: LocatedElement): boolean {
  return element.tags?.amenity === 'university' || element.tags?.amenity === 'college'
}

export function isSchoolOrChildcare(element: LocatedElement): boolean {
  return element.tags?.amenity === 'school' || element.tags?.amenity === 'kindergarten'
}

export function isWorkplaceSignal(element: LocatedElement): boolean {
  return isIndustrial(element)
    || isCommercial(element)
    || isUniversity(element)
    || element.tags?.office != null
    || element.tags?.amenity === 'hospital'
    || element.tags?.shop === 'mall'
    || element.tags?.shop === 'department_store'
}

export function isAirport(element: LocatedElement): boolean {
  return element.tags?.aeroway === 'aerodrome'
}

export function isRunway(element: LocatedElement): boolean {
  return element.tags?.aeroway === 'runway'
}

export function isHelipad(element: LocatedElement): boolean {
  return element.tags?.aeroway === 'helipad' || element.tags?.aeroway === 'heliport'
}
