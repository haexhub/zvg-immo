import type {
  DataSourceAttribution,
  LocationAmenityKind,
  LocationAmenitySummary,
  LocationContext,
  LocationDemographicContext,
  LocationEnvironmentContext,
  LocationMapFeature,
  LocationMapFeatureKind,
  LocationMobilityContext,
  NearbyPlace,
  NearbyPlaceKind,
  NeighborhoodContext,
} from '~/types/auction'
import type { Auction } from '~/types/auction'
import type { LocationContextAdapter } from '~/server/tasks/external-enrichment'
import { distanceMeters, type Point } from './geo'

export interface OsmLocationContextOptions {
  endpoint: string
  checkedAt: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

interface OverpassResponse {
  elements?: OsmElement[]
}

interface OsmElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat?: number; lon?: number }
  tags?: Record<string, string>
}

type LocatedElement = OsmElement & { point: Point; distanceMeters: number }

const SOURCE: DataSourceAttribution = {
  id: 'openstreetmap-overpass',
  label: 'OpenStreetMap / Overpass',
  url: 'https://www.openstreetmap.org/copyright',
  licenseNote: 'OpenStreetMap data is available under the Open Database License; coverage and tag quality vary by region.',
}

const PLACE_KINDS = new Set<NearbyPlaceKind>([
  'city',
  'town',
  'suburb',
  'village',
  'hamlet',
  'island',
  'municipality',
])

const MAJOR_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary'])
const NOISY_ROADS = new Set(['motorway', 'trunk', 'primary'])
const INDUSTRIAL_LANDUSE = new Set(['industrial', 'quarry', 'landfill', 'brownfield'])
const COMMERCIAL_LANDUSE = new Set(['commercial', 'retail'])
const HEAVY_INDUSTRY_TAGS = new Set([
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
])
const BUILDING_RADIUS_METERS = 500
const BUILDING_RADIUS_SQ_KM = Math.PI * (BUILDING_RADIUS_METERS / 1000) ** 2
const AMENITY_KINDS: LocationAmenityKind[] = [
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

export function createOsmLocationContextAdapter(options: OsmLocationContextOptions): LocationContextAdapter {
  const endpoint = options.endpoint.trim()
  return {
    id: 'osm-location-context',
    sourceVersion: 'osm-overpass-v1',
    supports: (auction) => !!endpoint && isFinitePoint(auction),
    async context(auction) {
      const point = { lat: auction.lat!, lng: auction.lng! }
      const timeoutMs = options.timeoutMs ?? 20_000
      const response = await postOverpass(endpoint, buildQuery(point, timeoutMs), options.fetchImpl ?? fetch, timeoutMs)
      return buildLocationContext(point, response.elements ?? [], options.checkedAt)
    },
  }
}

function isFinitePoint(auction: Auction): boolean {
  return Number.isFinite(auction.lat) && Number.isFinite(auction.lng)
}

async function postOverpass(
  endpoint: string,
  query: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<OverpassResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const body = new URLSearchParams({ data: query })
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'user-agent': 'PropHammer location enrichment (contact via deployment operator)',
      },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Overpass returned ${res.status}`)
    return await res.json() as OverpassResponse
  } finally {
    clearTimeout(timer)
  }
}

function buildQuery(point: Point, timeoutMs: number): string {
  const lat = point.lat.toFixed(6)
  const lng = point.lng.toFixed(6)
  const overpassTimeoutSec = Math.max(1, Math.floor(timeoutMs / 1000))
  return `
[out:json][timeout:${overpassTimeoutSec}];
(
  nwr(around:30000,${lat},${lng})["place"~"^(city|town|suburb|village|hamlet|island|municipality)$"];
  nwr(around:3000,${lat},${lng})["public_transport"~"^(platform|stop_position|station)$"];
  node(around:3000,${lat},${lng})["highway"="bus_stop"];
  nwr(around:3000,${lat},${lng})["railway"~"^(station|halt|tram_stop)$"];
  nwr(around:10000,${lat},${lng})["amenity"="ferry_terminal"];
  nwr(around:10000,${lat},${lng})["route"="ferry"];
  nwr(around:15000,${lat},${lng})["aeroway"~"^(aerodrome|runway|helipad|heliport)$"];
  way(around:8000,${lat},${lng})["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"];
  nwr(around:5000,${lat},${lng})["landuse"~"^(industrial|commercial|retail|quarry|landfill|brownfield)$"];
  nwr(around:5000,${lat},${lng})["industrial"];
  nwr(around:5000,${lat},${lng})["man_made"~"^(works|wastewater_plant|petroleum_well|mineshaft)$"];
  nwr(around:5000,${lat},${lng})["power"~"^(plant|generator|substation)$"];
  nwr(around:5000,${lat},${lng})["amenity"~"^(waste_transfer_station|recycling|ferry_terminal)$"];
  nwr(around:10000,${lat},${lng})["amenity"~"^(college|university)$"];
  nwr(around:5000,${lat},${lng})["office"];
  nwr(around:500,${lat},${lng})["building"];
  nwr(around:5000,${lat},${lng})["amenity"~"^(school|kindergarten|college|university|doctors|clinic|hospital|pharmacy|bank|atm|fuel|restaurant|cafe|bar|fast_food|post_office|library|community_centre)$"];
  nwr(around:5000,${lat},${lng})["shop"~"^(supermarket|convenience|bakery|butcher|mall|department_store)$"];
  nwr(around:5000,${lat},${lng})["leisure"~"^(park|sports_centre|playground|fitness_centre|garden)$"];
  nwr(around:500,${lat},${lng})["abandoned"];
  nwr(around:500,${lat},${lng})["disused"];
  nwr(around:500,${lat},${lng})["ruins"];
  nwr(around:500,${lat},${lng})["building"~"^(ruins|collapsed|abandoned)$"];
  nwr(around:500,${lat},${lng})["historic"="ruins"];
);
out center tags;
`.trim()
}

export function buildLocationContext(point: Point, elements: OsmElement[], checkedAt: string): LocationContext {
  const located = elements.map((element) => locateElement(point, element)).filter((element): element is LocatedElement => !!element)
  const places = nearbyPlaces(located)
  const stopElements = located.filter(isTransitStop)
  const railElements = located.filter(isRailStation)
  const ferryTerminalElements = located.filter(hasTag('amenity', 'ferry_terminal'))
  const ferryRouteElements = located.filter(hasTag('route', 'ferry'))
  const majorRoadElements = located.filter((element) => MAJOR_ROADS.has(element.tags?.highway ?? ''))
  const noisyRoadElements = located.filter((element) => NOISY_ROADS.has(element.tags?.highway ?? ''))
  const airportElements = uniqueLocated(located.filter(isAirport))
  const runwayElements = uniqueLocated(located.filter(isRunway))
  const helipadElements = uniqueLocated(located.filter(isHelipad))
  const industrialElements = uniqueLocated(located.filter(isIndustrial))
  const commercialElements = uniqueLocated(located.filter(isCommercial))
  const heavyIndustryElements = uniqueLocated(located.filter(isHeavyIndustry))
  const universityElements = uniqueLocated(located.filter(isUniversity))
  const schoolOrChildcareElements = uniqueLocated(located.filter(isSchoolOrChildcare))
  const workplaceElements = uniqueLocated(located.filter(isWorkplaceSignal))
  const buildingElements = uniqueLocated(located.filter((element) => element.tags?.building != null && element.distanceMeters <= BUILDING_RADIUS_METERS))
  const amenityElements = uniqueLocated(located.filter((element) => element.tags?.amenity != null && element.distanceMeters <= 1000))
  const amenitySummaries = amenityContext(located)
  const vacantOrRuinElements = uniqueLocated(located.filter((element) => element.distanceMeters <= BUILDING_RADIUS_METERS && isVacantOrRuin(element)))
  const neighborhood = neighborhoodContext(places, buildingElements.length, amenityElements.length, vacantOrRuinElements.length)
  const mobility: LocationMobilityContext = {
    publicTransportLevel: publicTransportLevel(stopElements, railElements),
    nearestStopDistanceMeters: nearestDistance(stopElements),
    stopCountWithin1000m: stopElements.filter((element) => element.distanceMeters <= 1000).length,
    stopCountWithin3000m: stopElements.filter((element) => element.distanceMeters <= 3000).length,
    nearestRailStationDistanceMeters: nearestDistance(railElements),
    roadAccessLevel: roadAccessLevel(majorRoadElements),
    nearestMajorRoadDistanceMeters: nearestDistance(majorRoadElements),
    majorRoadKinds: [...new Set(majorRoadElements.map((element) => element.tags?.highway).filter((value): value is string => !!value))].sort(),
    nearestFerryTerminalDistanceMeters: nearestDistance(ferryTerminalElements),
    hasFerryRouteNearby: ferryRouteElements.length > 0,
    ferryAccessLikely: ferryAccessLikely(places, ferryTerminalElements, ferryRouteElements),
  }
  const environment = environmentContext(industrialElements, commercialElements, heavyIndustryElements, noisyRoadElements, {
    airportElements,
    runwayElements,
    helipadElements,
  })
  const demographics = demographicContext(places, mobility, amenitySummaries, neighborhood, {
    universityElements,
    schoolOrChildcareElements,
    workplaceElements,
  })

  return {
    nearbyPlaces: places.slice(0, 6),
    mobility,
    amenities: amenitySummaries,
    environment,
    demographics,
    mapFeatures: mapFeatures({
      located,
      industrialElements,
      commercialElements,
      majorRoadElements,
      ferryTerminalElements,
      airportElements,
      runwayElements,
      helipadElements,
    }),
    neighborhood,
    quality: qualityAssessment(places, mobility, amenitySummaries, neighborhood, environment, demographics),
    source: SOURCE,
    checkedAt,
  }
}

function locateElement(origin: Point, element: OsmElement): LocatedElement | null {
  const lat = element.lat ?? element.center?.lat
  const lng = element.lon ?? element.center?.lon
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const point = { lat: lat!, lng: lng! }
  return { ...element, point, distanceMeters: Math.round(distanceMeters(origin, point)) }
}

function nearbyPlaces(elements: LocatedElement[]): NearbyPlace[] {
  return uniqueLocated(elements.filter((element) => PLACE_KINDS.has(placeKind(element.tags?.place))))
    .map((element) => ({
      name: nameOf(element),
      kind: placeKind(element.tags?.place),
      distanceMeters: element.distanceMeters,
      population: parsePopulation(element.tags?.population),
    }))
    .filter((place) => place.name)
    .sort((a, b) => placeRank(a.kind) - placeRank(b.kind) || a.distanceMeters - b.distanceMeters)
}

function nameOf(element: OsmElement): string {
  return (element.tags?.name ?? element.tags?.['name:de'] ?? element.tags?.['name:en'] ?? '').trim()
}

function placeKind(value: string | undefined): NearbyPlaceKind {
  return value && PLACE_KINDS.has(value as NearbyPlaceKind) ? value as NearbyPlaceKind : 'unknown'
}

function placeRank(kind: NearbyPlaceKind): number {
  if (kind === 'city') return 0
  if (kind === 'town') return 1
  if (kind === 'suburb') return 2
  if (kind === 'village') return 3
  if (kind === 'hamlet') return 4
  if (kind === 'municipality') return 5
  if (kind === 'island') return 6
  return 7
}

function parsePopulation(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number(value.replace(/\s/g, ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function isTransitStop(element: LocatedElement): boolean {
  return element.tags?.public_transport != null || element.tags?.highway === 'bus_stop' || isRailStation(element)
}

function isRailStation(element: LocatedElement): boolean {
  return ['station', 'halt', 'tram_stop'].includes(element.tags?.railway ?? '')
}

function hasTag(key: string, value: string): (element: LocatedElement) => boolean {
  return (element) => element.tags?.[key] === value
}

function amenityContext(elements: LocatedElement[]): LocationAmenitySummary[] {
  return AMENITY_KINDS.map((kind) => {
    const matching = uniqueLocated(elements.filter((element) => matchesAmenityKind(element, kind)))
    return {
      kind,
      nearestDistanceMeters: nearestDistance(matching),
      countWithin1000m: matching.filter((element) => element.distanceMeters <= 1000).length,
      countWithin3000m: matching.filter((element) => element.distanceMeters <= 3000).length,
      countWithin5000m: matching.filter((element) => element.distanceMeters <= 5000).length,
    }
  })
}

function matchesAmenityKind(element: LocatedElement, kind: LocationAmenityKind): boolean {
  const matched = amenityKind(element)
  if (matched === kind) return true
  if (kind === 'food') return matched === 'restaurant' || matched === 'cafe'
  if (kind === 'leisure') return matched === 'recreation'
  return false
}

function amenityKind(element: LocatedElement): LocationAmenityKind | null {
  const amenity = element.tags?.amenity
  const shop = element.tags?.shop
  const leisure = element.tags?.leisure
  if (shop && ['supermarket', 'convenience', 'bakery', 'butcher', 'mall', 'department_store'].includes(shop)) return 'groceries'
  if (amenity && ['school', 'kindergarten', 'college', 'university'].includes(amenity)) return 'education'
  if (amenity === 'hospital') return 'hospital'
  if (amenity && ['doctors', 'clinic'].includes(amenity)) return 'healthcare'
  if (amenity === 'pharmacy') return 'pharmacy'
  if (amenity && ['bank', 'atm'].includes(amenity)) return 'banking'
  if (amenity === 'fuel') return 'fuel'
  if (amenity === 'restaurant' || amenity === 'fast_food') return 'restaurant'
  if (amenity === 'cafe' || amenity === 'bar') return 'cafe'
  if (amenity && ['library', 'community_centre'].includes(amenity)) return 'leisure'
  if (leisure && ['park', 'sports_centre', 'playground', 'fitness_centre', 'garden'].includes(leisure)) return 'recreation'
  return null
}

function mapFeatureKind(element: LocatedElement): LocationMapFeatureKind | null {
  const amenity = element.tags?.amenity
  const shop = element.tags?.shop
  const highway = element.tags?.highway
  const railway = element.tags?.railway
  const leisure = element.tags?.leisure
  if (shop && ['supermarket', 'convenience', 'bakery', 'butcher', 'mall', 'department_store'].includes(shop)) return 'groceries'
  if (amenity === 'pharmacy') return 'pharmacy'
  if (amenity === 'hospital') return 'hospital'
  if (amenity && ['doctors', 'clinic'].includes(amenity)) return 'healthcare'
  if (amenity === 'school') return 'school'
  if (amenity === 'kindergarten') return 'childcare'
  if (amenity && ['college', 'university'].includes(amenity)) return 'university'
  if (element.tags?.public_transport != null || highway === 'bus_stop') return 'public_transport'
  if (railway && ['station', 'halt', 'tram_stop'].includes(railway)) return 'rail'
  if (isIndustrial(element) || isHeavyIndustry(element)) return 'industry'
  if (isCommercial(element)) return 'commercial'
  if (MAJOR_ROADS.has(highway ?? '')) return 'major_road'
  if (isAirport(element)) return 'airport'
  if (isRunway(element)) return 'runway'
  if (isHelipad(element)) return 'helipad'
  if (amenity === 'ferry_terminal' || element.tags?.route === 'ferry') return 'ferry'
  if (amenity === 'restaurant' || amenity === 'fast_food') return 'restaurant'
  if (amenity === 'cafe' || amenity === 'bar') return 'cafe'
  if (leisure && ['park', 'sports_centre', 'playground', 'fitness_centre', 'garden'].includes(leisure)) return 'recreation'
  if (leisure && ['park', 'sports_centre', 'playground', 'fitness_centre', 'garden'].includes(leisure)) return 'leisure'
  return null
}

function mapFeatures(input: {
  located: LocatedElement[]
  industrialElements: LocatedElement[]
  commercialElements: LocatedElement[]
  majorRoadElements: LocatedElement[]
  ferryTerminalElements: LocatedElement[]
  airportElements: LocatedElement[]
  runwayElements: LocatedElement[]
  helipadElements: LocatedElement[]
}): LocationMapFeature[] {
  const combined = uniqueLocated([
    ...input.located.filter((element) => mapFeatureKind(element) != null),
    ...input.industrialElements,
    ...input.commercialElements,
    ...input.majorRoadElements,
    ...input.ferryTerminalElements,
    ...input.airportElements,
    ...input.runwayElements,
    ...input.helipadElements,
  ])
  return combined
    .map((element): LocationMapFeature | null => {
      const kind = mapFeatureKind(element)
      if (!kind) return null
      return {
        kind,
        name: nameOf(element) || null,
        lat: element.point.lat,
        lng: element.point.lng,
        distanceMeters: element.distanceMeters,
        osmType: element.type,
        osmId: element.id,
      }
    })
    .filter((feature): feature is LocationMapFeature => !!feature)
    .sort((a, b) => featureRank(a.kind) - featureRank(b.kind) || a.distanceMeters - b.distanceMeters)
    .slice(0, 120)
}

function featureRank(kind: LocationMapFeatureKind): number {
  if (kind === 'industry' || kind === 'commercial' || kind === 'major_road') return 0
  if (kind === 'airport' || kind === 'runway' || kind === 'helipad') return 0
  if (kind === 'groceries' || kind === 'pharmacy' || kind === 'healthcare') return 1
  if (kind === 'public_transport' || kind === 'rail') return 2
  if (kind === 'school' || kind === 'childcare' || kind === 'university') return 3
  if (kind === 'ferry') return 4
  return 5
}

function publicTransportLevel(stops: LocatedElement[], rails: LocatedElement[]): LocationContext['mobility']['publicTransportLevel'] {
  const stops1000 = stops.filter((element) => element.distanceMeters <= 1000).length
  const stops3000 = stops.filter((element) => element.distanceMeters <= 3000).length
  const nearestRail = nearestDistance(rails)
  if ((nearestRail != null && nearestRail <= 1500) || stops1000 >= 10) return 'excellent'
  if ((nearestRail != null && nearestRail <= 3000) || stops1000 >= 3 || stops3000 >= 10) return 'good'
  if (stops3000 > 0) return 'limited'
  return 'none'
}

function qualityAssessment(
  places: NearbyPlace[],
  mobility: LocationMobilityContext,
  amenities: LocationAmenitySummary[],
  neighborhood: NeighborhoodContext,
  environment: LocationEnvironmentContext,
  demographics: LocationDemographicContext,
): LocationContext['quality'] {
  let score = 50
  const strengths: string[] = []
  const weaknesses: string[] = []
  const caveats: string[] = [
    'osm_heuristic',
  ]

  const nearestCityOrTown = places.find((place) => place.kind === 'city' || place.kind === 'town')
  if (nearestCityOrTown) {
    if (nearestCityOrTown.distanceMeters <= 5000) {
      score += 12
      strengths.push('larger_place_nearby')
    } else if (nearestCityOrTown.distanceMeters <= 15000) {
      score += 6
      strengths.push('larger_place_regional')
    } else {
      score -= 8
      weaknesses.push('larger_place_far')
    }
  } else {
    score -= 10
    weaknesses.push('no_larger_place')
  }

  if (mobility.publicTransportLevel === 'excellent') {
    score += 14
    strengths.push('excellent_public_transport')
  } else if (mobility.publicTransportLevel === 'good') {
    score += 8
    strengths.push('good_public_transport')
  } else if (mobility.publicTransportLevel === 'limited') {
    score -= 3
    weaknesses.push('limited_public_transport')
  } else if (mobility.publicTransportLevel === 'none') {
    score -= 12
    weaknesses.push('no_public_transport')
  }

  if (mobility.roadAccessLevel === 'major') {
    score += 10
    strengths.push('major_road_access')
  } else if (mobility.roadAccessLevel === 'regional') {
    score += 4
  } else if (mobility.roadAccessLevel === 'remote') {
    score -= 10
    weaknesses.push('remote_road_access')
  }

  const groceries = amenity(amenities, 'groceries')
  const healthcare = amenity(amenities, 'healthcare')
  const pharmacy = amenity(amenities, 'pharmacy')
  const education = amenity(amenities, 'education')
  const food = amenity(amenities, 'food')
  if ((groceries?.nearestDistanceMeters ?? Infinity) <= 1500) {
    score += 8
    strengths.push('groceries_nearby')
  } else if ((groceries?.nearestDistanceMeters ?? Infinity) <= 5000) {
    score += 2
  } else {
    score -= 9
    weaknesses.push('no_groceries')
  }
  if ((healthcare?.countWithin5000m ?? 0) > 0 || (pharmacy?.countWithin5000m ?? 0) > 0) score += 4
  else {
    score -= 5
    weaknesses.push('no_healthcare')
  }
  if ((education?.countWithin3000m ?? 0) > 0) score += 3
  if ((food?.countWithin3000m ?? 0) >= 5) score += 2

  if (neighborhood.settlementPattern === 'urban' || neighborhood.settlementPattern === 'suburban') {
    score += 8
    strengths.push('dense_neighborhood')
  } else if (neighborhood.settlementPattern === 'village' || neighborhood.settlementPattern === 'rural') {
    score -= 4
    weaknesses.push('rural_setting')
  } else if (neighborhood.settlementPattern === 'remote') {
    score -= 14
    weaknesses.push('remote_setting')
  } else if (neighborhood.settlementPattern === 'island') {
    score -= 8
    weaknesses.push('island_or_ferry_setting')
  }

  if (neighborhood.vacantOrRuinCountWithin500m >= 3) {
    score -= 8
    weaknesses.push('many_vacancy_signals')
  } else if (neighborhood.vacantOrRuinCountWithin500m > 0) {
    score -= 3
    weaknesses.push('some_vacancy_signals')
  }

  if (environment.noisyRoadLevel === 'high') {
    score -= 10
    weaknesses.push('high_noise_road_pressure')
  } else if (environment.noisyRoadLevel === 'medium') {
    score -= 4
    weaknesses.push('medium_noise_road_pressure')
  }
  if (environment.aviationNoiseLevel === 'high') {
    score -= 10
    weaknesses.push('high_aviation_noise_pressure')
  } else if (environment.aviationNoiseLevel === 'medium') {
    score -= 4
    weaknesses.push('medium_aviation_noise_pressure')
  }
  if (environment.nearestHeavyIndustryDistanceMeters != null && environment.nearestHeavyIndustryDistanceMeters <= 3000) {
    score -= 10
    weaknesses.push('heavy_industry_nearby')
  } else if (environment.nearestIndustrialDistanceMeters != null && environment.nearestIndustrialDistanceMeters <= 1000) {
    score -= 5
    weaknesses.push('industrial_area_nearby')
  }
  if (demographics.youthSignal === 'high') {
    score += 6
    strengths.push('youthful_demographic_proxy')
  }
  if (demographics.employmentSignal === 'high') {
    score += 6
    strengths.push('employment_proxy_strong')
  } else if (demographics.employmentSignal === 'low') {
    score -= 5
    weaknesses.push('employment_proxy_weak')
  }
  if (demographics.declineRisk === 'high') {
    score -= 12
    weaknesses.push('decline_risk_proxy')
  } else if (demographics.declineRisk === 'medium') {
    score -= 5
  }

  if (mobility.ferryAccessLikely) {
    caveats.push('ferry_check_required')
  }
  if (neighborhood.buildingCountWithin500m === 0 && neighborhood.amenityCountWithin1000m === 0) {
    caveats.push('sparse_osm_data')
  }

  const boundedScore = Math.max(0, Math.min(100, Math.round(score)))
  return {
    score: boundedScore,
    verdict: qualityVerdict(boundedScore),
    strengths,
    weaknesses,
    caveats,
  }
}

function amenity(amenities: LocationAmenitySummary[], kind: LocationAmenityKind): LocationAmenitySummary | null {
  return amenities.find((item) => item.kind === kind) ?? null
}

function qualityVerdict(score: number): LocationContext['quality']['verdict'] {
  if (score >= 82) return 'excellent'
  if (score >= 68) return 'good'
  if (score >= 50) return 'average'
  if (score >= 32) return 'weak'
  return 'isolated'
}

function roadAccessLevel(roads: LocatedElement[]): LocationContext['mobility']['roadAccessLevel'] {
  const nearest = nearestDistance(roads)
  if (nearest == null) return 'remote'
  const kinds = new Set(roads.map((element) => element.tags?.highway))
  if (nearest <= 2000 || kinds.has('motorway') || kinds.has('trunk') || kinds.has('primary')) return 'major'
  if (nearest <= 5000) return 'regional'
  return 'local'
}

function environmentContext(
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

  return {
    industrialCountWithin1000m: industrialElements.filter((element) => element.distanceMeters <= 1000).length,
    industrialCountWithin3000m: industrialElements.filter((element) => element.distanceMeters <= 3000).length,
    commercialCountWithin1000m: commercialElements.filter((element) => element.distanceMeters <= 1000).length,
    commercialCountWithin3000m: commercialElements.filter((element) => element.distanceMeters <= 3000).length,
    nearestIndustrialDistanceMeters: nearestDistance(industrialElements),
    nearestCommercialDistanceMeters: nearestDistance(commercialElements),
    nearestHeavyIndustryDistanceMeters: nearestDistance(heavyIndustryElements),
    heavyIndustryKinds: [...new Set(heavyIndustryElements.flatMap(heavyIndustryKinds))].sort(),
    noisyRoadLevel: noisyRoadLevel(nearestMotorway, nearestPrimary),
    aviationNoiseLevel: aviationNoiseLevel(nearestAirport, nearestRunway, nearestHelipad),
    nearestMotorwayDistanceMeters: nearestMotorway,
    nearestPrimaryRoadDistanceMeters: nearestPrimary,
    nearestAirportDistanceMeters: nearestAirport,
    nearestRunwayDistanceMeters: nearestRunway,
    nearestHelipadDistanceMeters: nearestHelipad,
    riskSignals,
  }
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

function demographicContext(
  places: NearbyPlace[],
  mobility: LocationMobilityContext,
  amenities: LocationAmenitySummary[],
  neighborhood: NeighborhoodContext,
  input: {
    universityElements: LocatedElement[]
    schoolOrChildcareElements: LocatedElement[]
    workplaceElements: LocatedElement[]
  },
): LocationDemographicContext {
  const reasons: string[] = []
  const caveats = ['demographic_proxy_only']
  const universityDistance = nearestDistance(input.universityElements)
  const schoolCount = input.schoolOrChildcareElements.filter((element) => element.distanceMeters <= 3000).length
  const workplaceCount = input.workplaceElements.filter((element) => element.distanceMeters <= 5000).length
  const food = amenity(amenities, 'food')
  const leisure = amenity(amenities, 'leisure')
  const groceries = amenity(amenities, 'groceries')
  const cityOrTown = places.find((place) => place.kind === 'city' || place.kind === 'town')

  let youthPoints = 0
  if (universityDistance != null && universityDistance <= 10_000) {
    youthPoints += 3
    reasons.push('university_nearby')
  }
  if (schoolCount >= 4) {
    youthPoints += 2
    reasons.push('schools_childcare_nearby')
  } else if (schoolCount > 0) {
    youthPoints += 1
  }
  if ((food?.countWithin3000m ?? 0) >= 8 || (leisure?.countWithin3000m ?? 0) >= 4) youthPoints += 1
  if (mobility.publicTransportLevel === 'good' || mobility.publicTransportLevel === 'excellent') youthPoints += 1

  let employmentPoints = 0
  if (workplaceCount >= 20) {
    employmentPoints += 3
    reasons.push('many_workplace_signals')
  } else if (workplaceCount >= 6) {
    employmentPoints += 2
    reasons.push('some_workplace_signals')
  }
  if (cityOrTown && cityOrTown.distanceMeters <= 10_000) employmentPoints += 1
  if (mobility.roadAccessLevel === 'major') employmentPoints += 1

  let declinePoints = 0
  if (!cityOrTown || cityOrTown.distanceMeters > 20_000) {
    declinePoints += 2
    reasons.push('far_from_larger_place')
  }
  if (mobility.publicTransportLevel === 'none') declinePoints += 2
  if ((groceries?.countWithin5000m ?? 0) === 0) declinePoints += 2
  if (neighborhood.settlementPattern === 'remote') declinePoints += 3
  else if (neighborhood.settlementPattern === 'rural' || neighborhood.settlementPattern === 'village') declinePoints += 1
  if (neighborhood.vacantOrRuinCountWithin500m > 0) declinePoints += 1
  if (declinePoints >= 5) reasons.push('rural_decline_proxy')

  return {
    youthSignal: levelFromPoints(youthPoints),
    employmentSignal: levelFromPoints(employmentPoints),
    declineRisk: declineRiskLevel(declinePoints),
    universityDistanceMeters: universityDistance,
    schoolOrChildcareCountWithin3000m: schoolCount,
    workplaceSignalCountWithin5000m: workplaceCount,
    reasons: [...new Set(reasons)],
    caveats,
  }
}

function levelFromPoints(points: number): LocationDemographicContext['youthSignal'] {
  if (points >= 4) return 'high'
  if (points >= 2) return 'medium'
  return 'low'
}

function declineRiskLevel(points: number): LocationDemographicContext['declineRisk'] {
  if (points >= 5) return 'high'
  if (points >= 3) return 'medium'
  return 'low'
}

function isIndustrial(element: LocatedElement): boolean {
  const landuse = element.tags?.landuse
  return (landuse != null && INDUSTRIAL_LANDUSE.has(landuse)) || element.tags?.industrial != null
}

function isCommercial(element: LocatedElement): boolean {
  const landuse = element.tags?.landuse
  return (landuse != null && COMMERCIAL_LANDUSE.has(landuse)) || element.tags?.office != null
}

function isHeavyIndustry(element: LocatedElement): boolean {
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

function isUniversity(element: LocatedElement): boolean {
  return element.tags?.amenity === 'university' || element.tags?.amenity === 'college'
}

function isSchoolOrChildcare(element: LocatedElement): boolean {
  return element.tags?.amenity === 'school' || element.tags?.amenity === 'kindergarten'
}

function isWorkplaceSignal(element: LocatedElement): boolean {
  return isIndustrial(element)
    || isCommercial(element)
    || isUniversity(element)
    || element.tags?.office != null
    || element.tags?.amenity === 'hospital'
    || element.tags?.shop === 'mall'
    || element.tags?.shop === 'department_store'
}

function isAirport(element: LocatedElement): boolean {
  return element.tags?.aeroway === 'aerodrome'
}

function isRunway(element: LocatedElement): boolean {
  return element.tags?.aeroway === 'runway'
}

function isHelipad(element: LocatedElement): boolean {
  return element.tags?.aeroway === 'helipad' || element.tags?.aeroway === 'heliport'
}

function ferryAccessLikely(
  places: NearbyPlace[],
  terminals: LocatedElement[],
  routes: LocatedElement[],
): boolean {
  return places.some((place) => place.kind === 'island' && place.distanceMeters <= 5000)
    || nearestDistance(terminals) != null
    || routes.length > 0
}

function neighborhoodContext(
  places: NearbyPlace[],
  buildingCount: number,
  amenityCount: number,
  vacantOrRuinCount: number,
): NeighborhoodContext {
  const density = Math.round(buildingCount / BUILDING_RADIUS_SQ_KM)
  const nearestPlace = places[0]
  const settlementPattern = inferSettlementPattern(places, density, amenityCount)
  const notes: NeighborhoodContext['notes'] = []
  if (buildingCount > 0) notes.push({ code: 'building_count_500m', params: { count: buildingCount } })
  if (amenityCount > 0) notes.push({ code: 'amenity_count_1000m', params: { count: amenityCount } })
  if (vacantOrRuinCount > 0) notes.push({ code: 'vacant_or_ruin_count_500m', params: { count: vacantOrRuinCount } })
  if (nearestPlace) notes.push({ code: 'nearest_place', params: { name: nearestPlace.name } })
  if (notes.length === 0) notes.push({ code: 'sparse_osm_neighborhood' })
  return {
    settlementPattern,
    buildingCountWithin500m: buildingCount,
    buildingDensityPerSqKm: Number.isFinite(density) ? density : null,
    amenityCountWithin1000m: amenityCount,
    vacantOrRuinCountWithin500m: vacantOrRuinCount,
    notes,
  }
}

function inferSettlementPattern(
  places: NearbyPlace[],
  buildingDensityPerSqKm: number,
  amenityCount: number,
): NeighborhoodContext['settlementPattern'] {
  if (places.some((place) => place.kind === 'island' && place.distanceMeters <= 5000)) return 'island'
  if (buildingDensityPerSqKm >= 700 || amenityCount >= 25) return 'urban'
  if (buildingDensityPerSqKm >= 250 || amenityCount >= 10) return 'suburban'
  const nearest = places[0]
  if (!nearest) return buildingDensityPerSqKm > 0 ? 'rural' : 'remote'
  if (nearest.kind === 'city' || nearest.kind === 'town') return nearest.distanceMeters <= 3000 ? 'town' : 'rural'
  if (nearest.kind === 'village' || nearest.kind === 'hamlet') return 'village'
  return 'rural'
}

function isVacantOrRuin(element: LocatedElement): boolean {
  return element.tags?.abandoned != null
    || element.tags?.disused != null
    || element.tags?.ruins != null
    || element.tags?.building === 'ruins'
    || element.tags?.building === 'collapsed'
    || element.tags?.building === 'abandoned'
    || element.tags?.historic === 'ruins'
}

function nearestDistance(elements: LocatedElement[]): number | null {
  if (elements.length === 0) return null
  return Math.min(...elements.map((element) => element.distanceMeters))
}

function uniqueLocated(elements: LocatedElement[]): LocatedElement[] {
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
