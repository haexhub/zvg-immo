import type {
  LocationAmenityKind,
  LocationAmenitySummary,
  LocationDemographicContext,
  LocationMobilityContext,
  NearbyPlace,
  NeighborhoodContext,
} from '~/types/auction'
import { nearestDistance, type LocatedElement } from './osm-location-shared'

export function demographicContext(
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

function amenity(amenities: LocationAmenitySummary[], kind: LocationAmenityKind): LocationAmenitySummary | null {
  return amenities.find((item) => item.kind === kind) ?? null
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
