import type { Auction, LocationContext, LocationNoiseIndicator, LocationNoiseObservation, LocationNoiseSource } from '~/types/auction'
import type { LocationContextEnhancer } from '~/server/tasks/external-enrichment'
import { maxOf } from '~/lib/array-math'
import { EXTERNAL_DATA_SOURCES } from './sources'

export interface EeaNoiseLayerConfig {
  source: LocationNoiseSource
  indicator: LocationNoiseIndicator
  imageServerUrl: string
}

export interface EeaEnvironmentalNoiseOptions {
  checkedAt: string
  serviceBaseUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  layers?: EeaNoiseLayerConfig[]
}

interface ArcGisIdentifyResponse {
  value?: string | number | null
  properties?: {
    Values?: Array<string | number | null>
  }
  catalogItems?: {
    features?: Array<{
      attributes?: Record<string, unknown>
    }>
  }
}

const SOURCE = EXTERNAL_DATA_SOURCES.find((source) => source.id === 'eea-environmental-noise-directive')!
const DEFAULT_SERVICE_BASE_URL = 'https://noise.discomap.eea.europa.eu/arcgis/rest/services/noiseStoryMap'
export const EEA_ENVIRONMENTAL_NOISE_SOURCE_VERSION = 'eea-end-noise-2025-image-contours-v1'

export function createEeaEnvironmentalNoiseEnhancer(options: EeaEnvironmentalNoiseOptions): LocationContextEnhancer {
  const layers = options.layers ?? defaultNoiseLayers(options.serviceBaseUrl)
  return {
    id: 'eea-environmental-noise',
    sourceVersion: EEA_ENVIRONMENTAL_NOISE_SOURCE_VERSION,
    supports: (auction) => Number.isFinite(auction.lat) && Number.isFinite(auction.lng) && layers.length > 0,
    async enhance(auction, context) {
      const observations = await readNoiseObservations(
        { lat: auction.lat!, lng: auction.lng! },
        layers,
        options,
      )
      return applyEnvironmentalNoise(context, observations)
    },
  }
}

export function defaultNoiseLayers(serviceBaseUrl = DEFAULT_SERVICE_BASE_URL): EeaNoiseLayerConfig[] {
  const base = serviceBaseUrl.replace(/\/+$/, '')
  return [
    { source: 'road', indicator: 'lden', imageServerUrl: `${base}/NoiseContours_road_lden/ImageServer` },
    { source: 'road', indicator: 'lnight', imageServerUrl: `${base}/NoiseContours_road_lnight/ImageServer` },
    { source: 'rail', indicator: 'lden', imageServerUrl: `${base}/NoiseContours_rail_lden/ImageServer` },
    { source: 'rail', indicator: 'lnight', imageServerUrl: `${base}/NoiseContours_rail_lnight/ImageServer` },
    { source: 'aviation', indicator: 'lden', imageServerUrl: `${base}/NoiseContours_air_lden/ImageServer` },
    { source: 'aviation', indicator: 'lnight', imageServerUrl: `${base}/NoiseContours_air_lnight/ImageServer` },
  ]
}

export async function readNoiseObservations(
  point: { lat: number; lng: number },
  layers: EeaNoiseLayerConfig[],
  options: EeaEnvironmentalNoiseOptions,
): Promise<LocationNoiseObservation[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  const results = await Promise.allSettled(layers.map(async (layer) => {
    const response = await identifyNoiseValue(point, layer, fetchImpl, options.timeoutMs ?? 10_000)
    return noiseObservation(layer, response, options.checkedAt)
  }))
  return results.flatMap((result, index) => {
    if (result.status === 'rejected') {
      const layer = layers[index]
      console.warn(`[eea-environmental-noise] ${layer?.source ?? 'unknown'}/${layer?.indicator ?? 'unknown'} identify failed: ${(result.reason as Error)?.message ?? result.reason}`)
      return []
    }
    return result.value ? [result.value] : []
  })
}

export function applyEnvironmentalNoise(
  context: LocationContext,
  observations: LocationNoiseObservation[],
): LocationContext {
  if (observations.length === 0) return context

  const environment = { ...context.environment }
  const riskSignals = new Set(environment.riskSignals)
  const roadLevel = maxObservedLevel(observations.filter((observation) => observation.source === 'road'))
  const railLevel = maxObservedLevel(observations.filter((observation) => observation.source === 'rail'))
  const aviationLevel = maxObservedLevel(observations.filter((observation) => observation.source === 'aviation'))

  if (roadLevel) {
    environment.noisyRoadLevel = maxLevel(environment.noisyRoadLevel, roadLevel)
    riskSignals.add(`eea_road_noise_${roadLevel}`)
  }
  if (railLevel) riskSignals.add(`eea_rail_noise_${railLevel}`)
  if (aviationLevel) {
    environment.aviationNoiseLevel = maxLevel(environment.aviationNoiseLevel, aviationLevel)
    riskSignals.add(`eea_aviation_noise_${aviationLevel}`)
  }

  environment.reportedNoise = [
    ...(environment.reportedNoise ?? []),
    ...observations,
  ]
  environment.riskSignals = [...riskSignals]

  return {
    ...context,
    environment,
    quality: adjustQualityForNoise(context.quality, { roadLevel, railLevel, aviationLevel }),
    source: {
      ...context.source,
      label: `${context.source.label} + ${SOURCE.label}`,
      licenseNote: `${context.source.licenseNote} ${SOURCE.licenseNote}`,
    },
  }
}

async function identifyNoiseValue(
  point: { lat: number; lng: number },
  layer: EeaNoiseLayerConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ArcGisIdentifyResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const url = new URL(`${layer.imageServerUrl.replace(/\/+$/, '')}/identify`)
    url.searchParams.set('f', 'json')
    url.searchParams.set('geometryType', 'esriGeometryPoint')
    url.searchParams.set('returnGeometry', 'false')
    url.searchParams.set('geometry', JSON.stringify({
      x: point.lng,
      y: point.lat,
      spatialReference: { wkid: 4326 },
    }))
    const res = await fetchImpl(url, {
      headers: {
        'user-agent': 'PropHammer location enrichment (contact via deployment operator)',
      },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`EEA noise identify returned ${res.status}`)
    return await res.json() as ArcGisIdentifyResponse
  } finally {
    clearTimeout(timer)
  }
}

function noiseObservation(
  layer: EeaNoiseLayerConfig,
  response: ArcGisIdentifyResponse,
  checkedAt: string,
): LocationNoiseObservation | null {
  const value = strongestRasterValue(response)
  if (value == null) return null
  const band = noiseBand(value, layer.indicator)
  return {
    source: layer.source,
    indicator: layer.indicator,
    level: band.level,
    bandLabel: band.label,
    minDb: band.minDb,
    maxDb: band.maxDb,
    value,
    sourceLayerName: sourceLayerName(response),
    sourceLabel: SOURCE.label,
    sourceUrl: SOURCE.sourceUrl,
    checkedAt,
  }
}

function strongestRasterValue(response: ArcGisIdentifyResponse): number | null {
  const values = [
    response.value,
    ...(response.properties?.Values ?? []),
  ].map(parseRasterValue).filter((value): value is number => value != null)
  if (values.length === 0) return null
  return maxOf(values)
}

function parseRasterValue(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null
  if (typeof value !== 'string') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null
}

function noiseBand(value: number, indicator: LocationNoiseIndicator): {
  label: string
  minDb: number | null
  maxDb: number | null
  level: LocationNoiseObservation['level']
} {
  const bands = indicator === 'lden'
    ? [
        { label: '55-59 dB Lden', minDb: 55, maxDb: 59 },
        { label: '60-64 dB Lden', minDb: 60, maxDb: 64 },
        { label: '65-69 dB Lden', minDb: 65, maxDb: 69 },
        { label: '70-74 dB Lden', minDb: 70, maxDb: 74 },
        { label: '>=75 dB Lden', minDb: 75, maxDb: null },
      ]
    : [
        { label: '50-54 dB Lnight', minDb: 50, maxDb: 54 },
        { label: '55-59 dB Lnight', minDb: 55, maxDb: 59 },
        { label: '60-64 dB Lnight', minDb: 60, maxDb: 64 },
        { label: '65-69 dB Lnight', minDb: 65, maxDb: 69 },
        { label: '>=70 dB Lnight', minDb: 70, maxDb: null },
      ]
  const index = Math.max(0, Math.min(bands.length - 1, value - 1))
  const band = bands[index]!
  return {
    ...band,
    level: value >= 4 ? 'high' : value >= 2 ? 'medium' : 'low',
  }
}

function sourceLayerName(response: ArcGisIdentifyResponse): string | null {
  const value = response.catalogItems?.features?.[0]?.attributes?.Name
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function maxObservedLevel(observations: LocationNoiseObservation[]): LocationNoiseObservation['level'] | null {
  const levels = observations.map((observation) => observation.level)
  if (levels.includes('high')) return 'high'
  if (levels.includes('medium')) return 'medium'
  if (levels.includes('low')) return 'low'
  return null
}

function maxLevel(
  current: 'low' | 'medium' | 'high' | 'unknown',
  observed: 'low' | 'medium' | 'high' | 'unknown',
): 'low' | 'medium' | 'high' | 'unknown' {
  const rank = { unknown: 0, low: 1, medium: 2, high: 3 }
  return rank[observed] > rank[current] ? observed : current
}

function adjustQualityForNoise(
  quality: LocationContext['quality'],
  levels: {
    roadLevel: LocationNoiseObservation['level'] | null
    railLevel: LocationNoiseObservation['level'] | null
    aviationLevel: LocationNoiseObservation['level'] | null
  },
): LocationContext['quality'] {
  const weaknesses = new Set(quality.weaknesses)
  const caveats = new Set(quality.caveats)
  let penalty = 0
  if (levels.roadLevel === 'high') {
    penalty += 8
    weaknesses.add('high_noise_road_pressure')
  } else if (levels.roadLevel === 'medium') {
    penalty += 3
    weaknesses.add('medium_noise_road_pressure')
  }
  if (levels.railLevel === 'high') {
    penalty += 5
    weaknesses.add('high_rail_noise_pressure')
  } else if (levels.railLevel === 'medium') {
    penalty += 2
    weaknesses.add('medium_rail_noise_pressure')
  }
  if (levels.aviationLevel === 'high') {
    penalty += 8
    weaknesses.add('high_aviation_noise_pressure')
  } else if (levels.aviationLevel === 'medium') {
    penalty += 3
    weaknesses.add('medium_aviation_noise_pressure')
  }
  caveats.add('eea_end_noise_data')
  const score = Math.max(0, Math.min(100, quality.score - penalty))
  return {
    ...quality,
    score,
    verdict: qualityVerdict(score),
    weaknesses: [...weaknesses],
    caveats: [...caveats],
  }
}

function qualityVerdict(score: number): LocationContext['quality']['verdict'] {
  if (score >= 82) return 'excellent'
  if (score >= 68) return 'good'
  if (score >= 50) return 'average'
  if (score >= 32) return 'weak'
  return 'isolated'
}
