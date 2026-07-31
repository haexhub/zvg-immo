<script setup lang="ts">
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
import type { AuctionDetail } from '~/server/api/auction/[platform]/[id].get'
import { safeHref } from '~/lib/utils'
import { useAuctionDetailFormatters } from '~/composables/useAuctionDetailFormatters'

const props = defineProps<{
  auction: AuctionDetail
}>()

const { t } = useI18n()
const intlLocale = useIntlLocale()
const {
  formatDistance,
  formatShortDate,
  formatConcentration,
  formatPopulation,
  demographicSignalLabel,
} = useAuctionDetailFormatters()

const locationContext = computed(() => props.auction.locationEnrichment?.locationContext ?? null)
const nearbyPlaces = computed(() => locationContext.value?.nearbyPlaces ?? [])
const locationMobility = computed(() => locationContext.value?.mobility ?? null)
const locationAmenities = computed(() => locationContext.value?.amenities ?? [])
const locationQuality = computed(() => locationContext.value?.quality ?? null)
const locationEnvironment = computed(() => locationContext.value?.environment ?? null)
const heavyIndustrySites = computed(() => locationEnvironment.value?.heavyIndustrySites ?? [])
const reportedNoise = computed(() => locationEnvironment.value?.reportedNoise ?? [])
const airQuality = computed(() => locationEnvironment.value?.airQuality ?? null)
const locationDemographics = computed(() => locationContext.value?.demographics ?? null)
const neighborhoodContext = computed(() => locationContext.value?.neighborhood ?? null)
const neighborhoodNotes = computed(() => neighborhoodContext.value?.notes ?? [])

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

</script>

<template>
  <section class="mt-8 space-y-5">
    <h2 class="text-2xl font-semibold tracking-tight">{{ $t('objektDetail.location') }}</h2>
    <template v-if="auction.lat != null && auction.lng != null">
      <AuctionDetailMap
        :lat="auction.lat"
        :lng="auction.lng"
        :label="auction.address ?? undefined"
        :hazards="auction.locationEnrichment?.hazards"
        :location-context="locationContext"
      />
      <div>
        <div v-if="locationContext" class="space-y-6">
          <DetailSectionCard v-if="locationQuality" :title="$t('objektDetail.locationQualityTitle')">
            <div class="space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <Badge variant="outline" :class="locationQualityClass(locationQuality.verdict)">
                  {{ locationQualityLabel(locationQuality.verdict) }}
                </Badge>
                <span class="text-sm font-semibold tabular-nums">{{ locationQuality.score }}/100</span>
              </div>
              <div v-if="locationQuality.strengths.length || locationQuality.weaknesses.length" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div v-if="locationQuality.strengths.length" class="rounded-md border bg-emerald-50/60 p-3">
                  <h3 class="text-xs font-semibold uppercase tracking-wide text-emerald-700">{{ $t('objektDetail.locationStrengths') }}</h3>
                  <ul class="mt-2 list-disc list-inside space-y-1 text-xs text-emerald-900">
                    <li v-for="(item, i) in locationQuality.strengths" :key="i">{{ locationSignalLabel(item) }}</li>
                  </ul>
                </div>
                <div v-if="locationQuality.weaknesses.length" class="rounded-md border bg-amber-50/60 p-3">
                  <h3 class="text-xs font-semibold uppercase tracking-wide text-amber-700">{{ $t('objektDetail.locationWeaknesses') }}</h3>
                  <ul class="mt-2 list-disc list-inside space-y-1 text-xs text-amber-900">
                    <li v-for="(item, i) in locationQuality.weaknesses" :key="i">{{ locationSignalLabel(item) }}</li>
                  </ul>
                </div>
              </div>
            </div>
          </DetailSectionCard>

          <DetailSectionCard :title="$t('objektDetail.nearbyPlaces')">
            <div class="space-y-5">
              <div>
                <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearbyPlacesTitle') }}</h3>
                <ul v-if="nearbyPlaces.length" class="divide-y rounded-md border text-sm">
                  <li
                    v-for="place in nearbyPlaces"
                    :key="`${place.kind}:${place.name}:${place.distanceMeters}`"
                    class="flex items-start justify-between gap-3 px-3 py-2.5"
                  >
                    <span class="min-w-0">
                      <span class="block truncate font-medium">{{ place.name }}</span>
                      <span class="text-xs text-muted-foreground">
                        {{ placeKindLabel(place.kind) }}
                        <span v-if="formatPopulation(place)"> · {{ formatPopulation(place) }}</span>
                      </span>
                    </span>
                    <span class="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                      {{ formatDistance(place.distanceMeters) }}
                    </span>
                  </li>
                </ul>
                <p v-else class="text-sm text-muted-foreground">{{ $t('objektDetail.noNearbyPlaces') }}</p>
              </div>

              <div v-if="locationMobility" class="space-y-3">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.mobilityTitle') }}</h3>
                <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.publicTransport') }}</dt>
                    <dd class="font-medium">{{ publicTransportLevelLabel(locationMobility.publicTransportLevel) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestStop') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatDistance(locationMobility.nearestStopDistanceMeters) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.roadAccess') }}</dt>
                    <dd class="font-medium">{{ roadAccessLevelLabel(locationMobility.roadAccessLevel) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestMajorRoad') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatDistance(locationMobility.nearestMajorRoadDistanceMeters) }}</dd>
                  </div>
                  <div v-if="locationMobility.nearestRailStationDistanceMeters != null">
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestRail') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatDistance(locationMobility.nearestRailStationDistanceMeters) }}</dd>
                  </div>
                  <div v-if="locationMobility.ferryAccessLikely">
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.ferryAccess') }}</dt>
                    <dd class="font-medium">
                      {{ locationMobility.nearestFerryTerminalDistanceMeters != null ? formatDistance(locationMobility.nearestFerryTerminalDistanceMeters) : $t('objektDetail.ferryRouteNearby') }}
                    </dd>
                  </div>
                </dl>
                <p class="text-xs text-muted-foreground">
                  {{ $t('objektDetail.publicTransportStops', { near: locationMobility.stopCountWithin1000m, wider: locationMobility.stopCountWithin3000m }) }}
                </p>
              </div>
            </div>
          </DetailSectionCard>

          <DetailSectionCard v-if="locationEnvironment" :title="$t('objektDetail.environmentTitle')">
            <div class="space-y-3">
              <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.noisyRoads') }}</dt>
                  <dd class="font-medium">{{ noisyRoadLevelLabel(locationEnvironment.noisyRoadLevel) }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.aviationNoise') }}</dt>
                  <dd class="font-medium">{{ aviationNoiseLevelLabel(locationEnvironment.aviationNoiseLevel) }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestMotorway') }}</dt>
                  <dd class="font-medium tabular-nums">{{ formatDistance(locationEnvironment.nearestMotorwayDistanceMeters) }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestAirport') }}</dt>
                  <dd class="font-medium tabular-nums">{{ formatDistance(locationEnvironment.nearestAirportDistanceMeters) }}</dd>
                  <dd v-if="locationEnvironment.nearestAirportName" class="text-xs text-muted-foreground">
                    {{ locationEnvironment.nearestAirportName }} · {{ airportKindLabel(locationEnvironment.nearestAirportKind) }}
                  </dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestRunway') }}</dt>
                  <dd class="font-medium tabular-nums">{{ formatDistance(locationEnvironment.nearestRunwayDistanceMeters) }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestHelipad') }}</dt>
                  <dd class="font-medium tabular-nums">{{ formatDistance(locationEnvironment.nearestHelipadDistanceMeters) }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestIndustrial') }}</dt>
                  <dd class="font-medium tabular-nums">{{ formatDistance(locationEnvironment.nearestIndustrialDistanceMeters) }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.nearestHeavyIndustry') }}</dt>
                  <dd class="font-medium tabular-nums">{{ formatDistance(locationEnvironment.nearestHeavyIndustryDistanceMeters) }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.commercialAreas') }}</dt>
                  <dd class="font-medium tabular-nums">{{ locationEnvironment.commercialCountWithin3000m.toLocaleString(intlLocale) }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.industrialAreas') }}</dt>
                  <dd class="font-medium tabular-nums">{{ locationEnvironment.industrialCountWithin3000m.toLocaleString(intlLocale) }}</dd>
                </div>
              </dl>
              <div v-if="heavyIndustrySites.length" class="space-y-2">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {{ $t('objektDetail.nearbyIndustrialSitesTitle') }}
                </h3>
                <ul class="divide-y rounded-md border text-sm">
                  <li
                    v-for="(site, i) in heavyIndustrySites"
                    :key="i"
                    class="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <span class="min-w-0 truncate">
                      {{ industrialSiteKindLabel(site.kind) }}
                      <span v-if="site.name" class="text-muted-foreground"> · {{ site.name }}</span>
                    </span>
                    <span class="shrink-0 font-medium tabular-nums text-muted-foreground">{{ formatDistance(site.distanceMeters) }}</span>
                  </li>
                </ul>
              </div>
              <div v-if="reportedNoise.length" class="space-y-2">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {{ $t('objektDetail.reportedNoiseTitle') }}
                </h3>
                <ul class="divide-y rounded-md border text-sm">
                  <li
                    v-for="observation in reportedNoise"
                    :key="`${observation.source}-${observation.indicator}`"
                    class="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <span>{{ noiseObservationLabel(observation) }}</span>
                    <span class="shrink-0 font-medium tabular-nums">{{ observation.bandLabel }}</span>
                  </li>
                </ul>
                <p class="text-xs text-muted-foreground">
                  {{ $t('objektDetail.reportedNoiseHint') }}
                </p>
              </div>
              <div v-if="airQuality" class="space-y-2">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {{ $t('objektDetail.airQualityTitle') }}
                </h3>
                <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.airQualityIndex') }}</dt>
                    <dd class="font-medium">
                      {{ airQualityLevelLabel(airQuality.level) }}
                      <span v-if="airQuality.index != null" class="tabular-nums text-muted-foreground">({{ airQuality.index }})</span>
                    </dd>
                  </div>
                  <div v-if="airQuality.particulateMatter25 != null">
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.airQualityPm25') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatConcentration(airQuality.particulateMatter25) }}</dd>
                  </div>
                  <div v-if="airQuality.particulateMatter10 != null">
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.airQualityPm10') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatConcentration(airQuality.particulateMatter10) }}</dd>
                  </div>
                  <div v-if="airQuality.nitrogenDioxide != null">
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.airQualityNo2') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatConcentration(airQuality.nitrogenDioxide) }}</dd>
                  </div>
                  <div v-if="airQuality.ozone != null">
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.airQualityOzone') }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatConcentration(airQuality.ozone) }}</dd>
                  </div>
                </dl>
                <p class="text-xs text-muted-foreground">{{ $t('objektDetail.airQualityHint') }}</p>
              </div>
              <ul v-if="locationEnvironment.riskSignals.length" class="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                <li v-for="(item, i) in locationEnvironment.riskSignals" :key="i">{{ environmentSignalLabel(item) }}</li>
              </ul>
            </div>
          </DetailSectionCard>

          <DetailSectionCard v-if="locationDemographics" :title="$t('objektDetail.demographicsTitle')">
            <div class="space-y-3">
              <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.youthSignal') }}</dt>
                  <dd class="font-medium">{{ demographicSignalLabel(locationDemographics.youthSignal) }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.employmentSignal') }}</dt>
                  <dd class="font-medium">{{ demographicSignalLabel(locationDemographics.employmentSignal) }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.declineRisk') }}</dt>
                  <dd class="font-medium">{{ declineRiskLabel(locationDemographics.declineRisk) }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.universityDistance') }}</dt>
                  <dd class="font-medium tabular-nums">{{ formatDistance(locationDemographics.universityDistanceMeters) }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.schoolsChildcare') }}</dt>
                  <dd class="font-medium tabular-nums">{{ locationDemographics.schoolOrChildcareCountWithin3000m.toLocaleString(intlLocale) }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.workplaceSignals') }}</dt>
                  <dd class="font-medium tabular-nums">{{ locationDemographics.workplaceSignalCountWithin5000m.toLocaleString(intlLocale) }}</dd>
                </div>
              </dl>
              <ul v-if="locationDemographics.reasons.length" class="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                <li v-for="(item, i) in locationDemographics.reasons" :key="i">{{ demographicReasonLabel(item) }}</li>
              </ul>
            </div>
          </DetailSectionCard>

          <DetailSectionCard v-if="locationAmenities.length || neighborhoodContext" :title="$t('objektDetail.dailyNeedsNeighborhoodTitle')">
            <div class="space-y-5">
              <div v-if="locationAmenities.length" class="space-y-3">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.dailyNeedsTitle') }}</h3>
                <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div v-for="item in locationAmenities" :key="item.kind">
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ amenityKindLabel(item.kind) }}</dt>
                    <dd class="font-medium tabular-nums">{{ formatDistance(item.nearestDistanceMeters) }}</dd>
                    <dd class="text-xs text-muted-foreground">{{ $t('objektDetail.amenityCounts', { near: item.countWithin1000m, wider: item.countWithin5000m }) }}</dd>
                  </div>
                </dl>
              </div>

              <div v-if="neighborhoodContext" class="space-y-3">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.neighborhoodSignalsTitle') }}</h3>
                <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.settlementPattern') }}</dt>
                    <dd class="font-medium">{{ settlementPatternLabel(neighborhoodContext.settlementPattern) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.buildingDensity') }}</dt>
                    <dd class="font-medium tabular-nums">
                      {{ neighborhoodContext.buildingDensityPerSqKm == null ? '–' : neighborhoodContext.buildingDensityPerSqKm.toLocaleString(intlLocale, { maximumFractionDigits: 0 }) }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.amenitiesNearby') }}</dt>
                    <dd class="font-medium tabular-nums">{{ neighborhoodContext.amenityCountWithin1000m.toLocaleString(intlLocale) }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs uppercase tracking-wide text-muted-foreground">{{ $t('objektDetail.vacantSignals') }}</dt>
                    <dd class="font-medium tabular-nums">{{ neighborhoodContext.vacantOrRuinCountWithin500m.toLocaleString(intlLocale) }}</dd>
                  </div>
                </dl>
                <ul v-if="neighborhoodNotes.length" class="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                  <li v-for="(item, i) in neighborhoodNotes" :key="i">{{ neighborhoodNoteLabel(item) }}</li>
                </ul>
              </div>
            </div>
          </DetailSectionCard>

          <DetailSectionCard :title="$t('objektDetail.locationSourceTitle')">
            <div class="space-y-3">
              <p class="text-xs text-muted-foreground">
                {{ $t('objektDetail.sourceChecked', { source: locationContext.source.label, date: formatShortDate(locationContext.checkedAt) }) }}
                <a :href="safeHref(locationContext.source.url)" target="_blank" rel="noopener" class="ml-1 underline underline-offset-2 hover:text-foreground">
                  {{ $t('objektDetail.sourceLink') }}
                </a>
              </p>
              <ul v-if="locationQuality?.caveats.length" class="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                <li v-for="(item, i) in locationQuality.caveats" :key="i">{{ locationCaveatLabel(item) }}</li>
              </ul>
              <ul v-if="locationDemographics?.caveats.length" class="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                <li v-for="(item, i) in locationDemographics.caveats" :key="i">{{ demographicCaveatLabel(item) }}</li>
              </ul>
              <p class="text-xs text-muted-foreground">{{ $t('objektDetail.locationContextDisclaimer') }}</p>
            </div>
          </DetailSectionCard>
        </div>
        <DetailSectionCard v-else :title="$t('objektDetail.nearbyPlaces')">
          <p class="text-sm text-muted-foreground">{{ $t('objektDetail.noExternalLocationContext') }}</p>
        </DetailSectionCard>
      </div>
    </template>
    <DetailSectionCard v-else :title="$t('objektDetail.nearbyPlaces')">
      <p class="text-sm text-muted-foreground">{{ $t('objektDetail.noExternalLocationContext') }}</p>
    </DetailSectionCard>
  </section>
</template>
