import type {
  LocationAmenityKind,
  LocationAmenitySummary,
  LocationContext,
  LocationMapFeature,
  LocationMapFeatureKind,
  LocationMobilityContext,
  NearbyPlace,
  NearbyPlaceKind,
  NeighborhoodContext,
} from '~/types/auction'
import { type Point } from './geo'
import { demographicContext } from './osm-location-demographics'
import {
  environmentContext,
  isAirport,
  isCommercial,
  isHeavyIndustry,
  isHelipad,
  isIndustrial,
  isRunway,
  isSchoolOrChildcare,
  isUniversity,
  isWorkplaceSignal,
} from './osm-location-environment'
import { qualityAssessment } from './osm-location-quality'
import {
  AMENITY_KINDS,
  BUILDING_RADIUS_METERS,
  BUILDING_RADIUS_SQ_KM,
  FERRY_RADIUS_METERS,
  HEAVY_INDUSTRY_RADIUS_METERS,
  MAJOR_ROADS,
  NOISY_ROADS,
  PLACE_KINDS,
  PLACE_RADIUS_METERS,
  SOURCE,
  hasTag,
  locateElement,
  nameOf,
  nearestDistance,
  placeKind,
  uniqueLocated,
  type LocatedElement,
  type OsmElement,
} from './osm-location-shared'

export function buildLocationContext(point: Point, elements: OsmElement[], checkedAt: string): LocationContext {
  const located = elements.map((element) => locateElement(point, element)).filter((element): element is LocatedElement => !!element)
  const places = nearbyPlaces(located)
  const stopElements = located.filter(isTransitStop)
  const railElements = located.filter(isRailStation)
  // Clipped: hasFerryRouteNearby and ferryAccessLikely() only ask whether one
  // exists, so without this the bbox corners would report ferry access for a
  // terminal 14 km out.
  const ferryTerminalElements = located.filter((element) =>
    element.distanceMeters <= FERRY_RADIUS_METERS && hasTag('amenity', 'ferry_terminal')(element))
  const ferryRouteElements = located.filter((element) =>
    element.distanceMeters <= FERRY_RADIUS_METERS && hasTag('route', 'ferry')(element))
  const majorRoadElements = located.filter((element) => MAJOR_ROADS.has(element.tags?.highway ?? ''))
  const noisyRoadElements = located.filter((element) => NOISY_ROADS.has(element.tags?.highway ?? ''))
  const airportElements = uniqueLocated(located.filter(isAirport))
  const runwayElements = uniqueLocated(located.filter(isRunway))
  const helipadElements = uniqueLocated(located.filter(isHelipad))
  const industrialElements = uniqueLocated(located.filter(isIndustrial))
  const commercialElements = uniqueLocated(located.filter(isCommercial))
  // Clipped: environmentContext() raises 'heavy_industry_mapped' on existence
  // alone, so a power plant 7 km out would otherwise flag the property.
  const heavyIndustryElements = uniqueLocated(located.filter((element) =>
    element.distanceMeters <= HEAVY_INDUSTRY_RADIUS_METERS && isHeavyIndustry(element)))
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

function nearbyPlaces(elements: LocatedElement[]): NearbyPlace[] {
  // Clipped to the circle: unlike every other consumer this has no metre
  // threshold of its own, so the bbox corners would otherwise surface places
  // out to ~42 km in a list documented as 30 km.
  return uniqueLocated(elements.filter((element) =>
    PLACE_KINDS.has(placeKind(element.tags?.place)) && element.distanceMeters <= PLACE_RADIUS_METERS))
    .map((element) => ({
      name: nameOf(element),
      kind: placeKind(element.tags?.place),
      distanceMeters: element.distanceMeters,
      population: parsePopulation(element.tags?.population),
    }))
    .filter((place) => place.name)
    .sort((a, b) => placeRank(a.kind) - placeRank(b.kind) || a.distanceMeters - b.distanceMeters)
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

function roadAccessLevel(roads: LocatedElement[]): LocationContext['mobility']['roadAccessLevel'] {
  const nearest = nearestDistance(roads)
  if (nearest == null) return 'remote'
  const kinds = new Set(roads.map((element) => element.tags?.highway))
  if (nearest <= 2000 || kinds.has('motorway') || kinds.has('trunk') || kinds.has('primary')) return 'major'
  if (nearest <= 5000) return 'regional'
  return 'local'
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
