import type {
  LocationAmenityKind,
  LocationAmenitySummary,
  LocationContext,
  LocationDemographicContext,
  LocationEnvironmentContext,
  LocationMobilityContext,
  NearbyPlace,
  NeighborhoodContext,
} from '~/types/auction'

export function qualityAssessment(
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
