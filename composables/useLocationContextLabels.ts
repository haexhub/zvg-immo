// i18n label/class lookups for the location-context enums shown in
// DetailLocationSection.vue — split out (same pattern as useEnumLabels.ts)
// to keep that component under the production size gate.
import type {
  LocationAirQualityLevel,
  LocationAmenityKind,
  LocationDemographicContext,
  LocationEnvironmentContext,
  LocationMobilityContext,
  LocationNoiseObservation,
  NearbyPlaceKind,
  NeighborhoodContext,
} from '~/types/auction'

export function useLocationContextLabels() {
  const { t } = useI18n()

  function locationQualityLabel(verdict: string): string {
    return t(`objektDetail.locationQualityVerdict.${verdict}`)
  }

  function locationQualityClass(verdict: string): string {
    if (verdict === 'excellent' || verdict === 'good') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
    if (verdict === 'average') return 'border-sky-200 bg-sky-50 text-sky-700'
    if (verdict === 'weak') return 'border-amber-200 bg-amber-50 text-amber-700'
    if (verdict === 'isolated') return 'border-destructive/30 bg-destructive/10 text-destructive'
    return 'border-slate-200 bg-slate-50 text-slate-700'
  }

  function locationSignalLabel(code: string): string {
    const key = `objektDetail.locationSignal.${code}`
    const translated = t(key)
    return translated === key ? code : translated
  }

  function locationCaveatLabel(code: string): string {
    const key = `objektDetail.locationCaveat.${code}`
    const translated = t(key)
    return translated === key ? code : translated
  }

  function placeKindLabel(kind: NearbyPlaceKind): string {
    return t(`objektDetail.placeKind.${kind}`)
  }

  function publicTransportLevelLabel(level: LocationMobilityContext['publicTransportLevel']): string {
    return t(`objektDetail.publicTransportLevel.${level}`)
  }

  function roadAccessLevelLabel(level: LocationMobilityContext['roadAccessLevel']): string {
    return t(`objektDetail.roadAccessLevel.${level}`)
  }

  function noisyRoadLevelLabel(level: LocationEnvironmentContext['noisyRoadLevel']): string {
    return t(`objektDetail.noisyRoadLevel.${level}`)
  }

  function aviationNoiseLevelLabel(level: LocationEnvironmentContext['aviationNoiseLevel']): string {
    return t(`objektDetail.aviationNoiseLevel.${level}`)
  }

  function airportKindLabel(kind: LocationEnvironmentContext['nearestAirportKind']): string {
    return t(`objektDetail.aviationAirportKind.${kind}`)
  }

  function industrialSiteKindLabel(kind: string): string {
    const key = `objektDetail.industrialSiteKind.${kind}`
    const translated = t(key)
    if (translated !== key) return translated
    const raw = kind.replace(/^(power_plant_|power_generator_|power_|man_made_|industrial_|amenity_|landuse_)/, '')
    return raw.replace(/_/g, ' ')
  }

  function noiseObservationLabel(observation: LocationNoiseObservation): string {
    return `${t(`objektDetail.noiseSource.${observation.source}`)} (${t(`objektDetail.noiseIndicator.${observation.indicator}`)})`
  }

  function airQualityLevelLabel(level: LocationAirQualityLevel): string {
    return t(`objektDetail.airQualityLevel.${level}`)
  }

  function environmentSignalLabel(code: string): string {
    const key = `objektDetail.environmentSignal.${code}`
    const translated = t(key)
    return translated === key ? code : translated
  }

  function declineRiskLabel(level: LocationDemographicContext['declineRisk']): string {
    return t(`objektDetail.declineRiskLevel.${level}`)
  }

  function demographicReasonLabel(code: string): string {
    const key = `objektDetail.demographicReason.${code}`
    const translated = t(key)
    return translated === key ? code : translated
  }

  function demographicCaveatLabel(code: string): string {
    const key = `objektDetail.demographicCaveat.${code}`
    const translated = t(key)
    return translated === key ? code : translated
  }

  function amenityKindLabel(kind: LocationAmenityKind): string {
    const key = `objektDetail.amenityKind.${kind}`
    const translated = t(key)
    return translated === key ? kind : translated
  }

  function settlementPatternLabel(pattern: NeighborhoodContext['settlementPattern']): string {
    return t(`objektDetail.settlementPatternLabel.${pattern}`)
  }

  function neighborhoodNoteLabel(note: NeighborhoodContext['notes'][number] | string): string {
    if (typeof note === 'string') return note
    const key = `objektDetail.neighborhoodNote.${note.code}`
    const translated = t(key, note.params ?? {})
    return translated === key ? note.code : translated
  }

  return {
    locationQualityLabel,
    locationQualityClass,
    locationSignalLabel,
    locationCaveatLabel,
    placeKindLabel,
    publicTransportLevelLabel,
    roadAccessLevelLabel,
    noisyRoadLevelLabel,
    aviationNoiseLevelLabel,
    airportKindLabel,
    industrialSiteKindLabel,
    noiseObservationLabel,
    airQualityLevelLabel,
    environmentSignalLabel,
    declineRiskLabel,
    demographicReasonLabel,
    demographicCaveatLabel,
    amenityKindLabel,
    settlementPatternLabel,
    neighborhoodNoteLabel,
  }
}
