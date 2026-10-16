// Location-enrichment payload types (market comparison, hazards, location
// context). Re-exported by ~/types/auction so importers keep one entry point.

export interface DataSourceAttribution {
  id: string
  label: string
  url: string
  licenseNote: string
}

export type MarketComparisonPropertyClass = 'house' | 'apartment' | 'land' | 'mixed' | 'unknown'

export interface MarketComparison {
  pricePerSqm: number | null
  basis: 'livingArea' | 'landArea'
  areaSqm: number
  regionLabel: string
  propertyClass: MarketComparisonPropertyClass
  medianPricePerSqm: number | null
  p25PricePerSqm: number | null
  p75PricePerSqm: number | null
  deltaPctVsMedian: number | null
  verdict: 'cheaper' | 'similar' | 'more_expensive' | 'insufficient_data'
  samples: number
  sources: DataSourceAttribution[]
}

export interface LandValueBaseline {
  valueEurPerSqm: number
  regionLabel: string
  zoneLabel: string | null
  distanceMeters: number | null
  source: DataSourceAttribution
  checkedAt: string
}

export type HazardKind =
  | 'flood'
  | 'wildfire'
  | 'avalanche'
  | 'earthquake'
  | 'landslide'
  | 'storm'
  | 'hail'
  | 'snow_load'

export interface HazardAssessment {
  hazard: HazardKind
  status: 'inside' | 'nearby' | 'outside' | 'unknown'
  severity: 'low' | 'medium' | 'high' | 'very_high' | 'unknown'
  distanceMeters: number | null
  sourceLabel: string
  sourceUrl: string
  checkedAt: string
  stale?: boolean
}

export type NearbyPlaceKind =
  | 'city'
  | 'town'
  | 'suburb'
  | 'village'
  | 'hamlet'
  | 'island'
  | 'municipality'
  | 'unknown'

export interface NearbyPlace {
  name: string
  kind: NearbyPlaceKind
  distanceMeters: number
  population: number | null
}

export interface LocationMobilityContext {
  publicTransportLevel: 'none' | 'limited' | 'good' | 'excellent' | 'unknown'
  nearestStopDistanceMeters: number | null
  stopCountWithin1000m: number
  stopCountWithin3000m: number
  nearestRailStationDistanceMeters: number | null
  /**
   * Passenger-rail access in the town/city catchment (15 km).  This is kept
   * separate from `nearestRailStationDistanceMeters`, which also includes
   * tram stops directly near the property.
   */
  regionalRailConnection?: 'available' | 'not_detected'
  regionalRailStationName?: string | null
  /**
   * An explicitly tagged long-distance service (for example ICE/IC/EC) at a
   * station in the town/city catchment.  OSM does not consistently carry
   * service information, so `not_detected` is deliberately not a claim that
   * no nationwide connection exists.
   */
  nationalRailConnection?: 'available' | 'not_detected'
  nationalRailStationName?: string | null
  roadAccessLevel: 'remote' | 'local' | 'regional' | 'major' | 'unknown'
  nearestMajorRoadDistanceMeters: number | null
  majorRoadKinds: string[]
  nearestFerryTerminalDistanceMeters: number | null
  hasFerryRouteNearby: boolean
  ferryAccessLikely: boolean
}

export type LocationAmenityKind =
  | 'groceries'
  | 'education'
  | 'healthcare'
  | 'hospital'
  | 'pharmacy'
  | 'banking'
  | 'fuel'
  | 'food'
  | 'restaurant'
  | 'cafe'
  | 'leisure'
  | 'recreation'

export interface LocationAmenitySummary {
  kind: LocationAmenityKind
  nearestDistanceMeters: number | null
  countWithin1000m: number
  countWithin3000m: number
  countWithin5000m: number
}

export type LocationMapFeatureKind =
  | 'groceries'
  | 'pharmacy'
  | 'healthcare'
  | 'hospital'
  | 'school'
  | 'childcare'
  | 'public_transport'
  | 'rail'
  | 'university'
  | 'industry'
  | 'commercial'
  | 'major_road'
  | 'airport'
  | 'runway'
  | 'helipad'
  | 'ferry'
  | 'restaurant'
  | 'cafe'
  | 'recreation'
  | 'leisure'

export interface LocationMapFeature {
  kind: LocationMapFeatureKind
  name: string | null
  lat: number
  lng: number
  distanceMeters: number
  osmType: 'node' | 'way' | 'relation'
  osmId: number
}

export interface LocationEnvironmentContext {
  industrialCountWithin1000m: number
  industrialCountWithin3000m: number
  commercialCountWithin1000m: number
  commercialCountWithin3000m: number
  nearestIndustrialDistanceMeters: number | null
  nearestCommercialDistanceMeters: number | null
  nearestHeavyIndustryDistanceMeters: number | null
  heavyIndustryKinds: string[]
  heavyIndustrySites: { kind: string; name: string | null; distanceMeters: number }[]
  noisyRoadLevel: 'low' | 'medium' | 'high' | 'unknown'
  aviationNoiseLevel: 'low' | 'medium' | 'high' | 'unknown'
  nearestMotorwayDistanceMeters: number | null
  nearestPrimaryRoadDistanceMeters: number | null
  nearestAirportDistanceMeters: number | null
  nearestRunwayDistanceMeters: number | null
  nearestHelipadDistanceMeters: number | null
  nearestAirportName: string | null
  nearestAirportKind: 'major' | 'regional' | 'minor' | 'military' | 'unknown'
  reportedNoise?: LocationNoiseObservation[]
  airQuality?: LocationAirQualityObservation | null
  climateNormals?: LocationClimateNormals | null
  riskSignals: string[]
}

/** European Air Quality Index bands, as published by the EEA. */
export type LocationAirQualityLevel =
  | 'good'
  | 'fair'
  | 'moderate'
  | 'poor'
  | 'very_poor'
  | 'extremely_poor'
  | 'unknown'

export interface LocationAirQualityObservation {
  /** European AQI value; null when the grid has no value for this point. */
  index: number | null
  level: LocationAirQualityLevel
  particulateMatter10: number | null
  particulateMatter25: number | null
  nitrogenDioxide: number | null
  ozone: number | null
  /** Timestamp of the modelled hour the values describe. */
  observedAt: string | null
  sourceLabel: string
  sourceUrl: string
  checkedAt: string
}

export interface LocationClimateMonthNormal {
  /** 1 = January … 12 = December. */
  month: number
  /** Average daily maximum temperature (°C) over the reference period. */
  tempMaxAvgC: number
  /** Average daily mean temperature (°C) over the reference period. */
  tempMeanAvgC: number
  /** Average daily minimum ("night") temperature (°C) over the reference period. */
  tempMinAvgC: number
  /** Average monthly precipitation total (mm) over the reference period. */
  precipitationAvgMm: number
}

export interface LocationClimateNormals {
  periodStartYear: number
  periodEndYear: number
  /** Twelve entries, ordered January (1) through December (12). */
  months: LocationClimateMonthNormal[]
  sourceLabel: string
  sourceUrl: string
  checkedAt: string
}

export type LocationNoiseSource = 'road' | 'rail' | 'aviation' | 'industry'
export type LocationNoiseIndicator = 'lden' | 'lnight'

export interface LocationNoiseObservation {
  source: LocationNoiseSource
  indicator: LocationNoiseIndicator
  level: 'low' | 'medium' | 'high' | 'unknown'
  bandLabel: string
  minDb: number | null
  maxDb: number | null
  value: number
  sourceLayerName: string | null
  sourceLabel: string
  sourceUrl: string
  checkedAt: string
}

export interface LocationDemographicContext {
  youthSignal: 'low' | 'medium' | 'high' | 'unknown'
  employmentSignal: 'low' | 'medium' | 'high' | 'unknown'
  declineRisk: 'low' | 'medium' | 'high' | 'unknown'
  universityDistanceMeters: number | null
  schoolOrChildcareCountWithin3000m: number
  workplaceSignalCountWithin5000m: number
  reasons: string[]
  caveats: string[]
}

export interface LocationContextNote {
  code: string
  params?: Record<string, number | string>
}

export interface NeighborhoodContext {
  settlementPattern: 'urban' | 'suburban' | 'town' | 'village' | 'rural' | 'remote' | 'island' | 'unknown'
  buildingCountWithin500m: number
  buildingDensityPerSqKm: number | null
  amenityCountWithin1000m: number
  vacantOrRuinCountWithin500m: number
  notes: LocationContextNote[]
}

export interface LocationQualityAssessment {
  score: number
  verdict: 'excellent' | 'good' | 'average' | 'weak' | 'isolated' | 'unknown'
  strengths: string[]
  weaknesses: string[]
  caveats: string[]
}

export interface LocationContext {
  nearbyPlaces: NearbyPlace[]
  mobility: LocationMobilityContext
  amenities: LocationAmenitySummary[]
  environment: LocationEnvironmentContext
  demographics: LocationDemographicContext
  mapFeatures: LocationMapFeature[]
  neighborhood: NeighborhoodContext
  quality: LocationQualityAssessment
  source: DataSourceAttribution
  checkedAt: string
}

export interface LocationEnrichment {
  platform: string
  externalId: string
  lat: number
  lng: number
  marketComparison?: MarketComparison | null
  landValueBaseline?: LandValueBaseline | null
  hazards?: HazardAssessment[] | null
  locationContext?: LocationContext | null
  checkedAt: string
  sourceVersion: string
}
