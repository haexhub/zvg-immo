// Air quality context for one auction's coordinates, from the Copernicus CAMS
// European analysis served by Open-Meteo's public air-quality API.
//
// Modelled as a LocationContextEnhancer rather than a HazardAssessmentAdapter:
// air quality is a continuous ambient property of the surroundings, like the
// EEA noise contours this mirrors, not a zone the parcel is inside or outside.
// The hazard overlays draw a coloured circle for containment, which would
// misrepresent a ~11 km grid average.

import type {
  Auction,
  LocationAirQualityLevel,
  LocationAirQualityObservation,
  LocationContext,
} from '~/types/auction'
import type { LocationContextEnhancer } from '~/server/tasks/external-enrichment'
import { EXTERNAL_DATA_SOURCES } from './sources'

export interface CamsAirQualityOptions {
  checkedAt: string
  serviceUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

interface AirQualityResponse {
  current?: {
    time?: string | null
    european_aqi?: number | null
    pm10?: number | null
    pm2_5?: number | null
    nitrogen_dioxide?: number | null
    ozone?: number | null
  } | null
}

const SOURCE = EXTERNAL_DATA_SOURCES.find((source) => source.id === 'cams-air-quality')!
const DEFAULT_SERVICE_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality'
const DEFAULT_TIMEOUT_MS = 10_000
export const CAMS_AIR_QUALITY_SOURCE_VERSION = 'cams-european-aqi-v1'

const CURRENT_FIELDS = ['european_aqi', 'pm10', 'pm2_5', 'nitrogen_dioxide', 'ozone'] as const

export function createCamsAirQualityEnhancer(options: CamsAirQualityOptions): LocationContextEnhancer {
  const serviceUrl = (options.serviceUrl ?? DEFAULT_SERVICE_URL).trim()
  return {
    id: 'cams-air-quality',
    sourceVersion: CAMS_AIR_QUALITY_SOURCE_VERSION,
    supports: (auction) => !!serviceUrl && Number.isFinite(auction.lat) && Number.isFinite(auction.lng),
    async enhance(auction, context) {
      const observation = await readAirQuality(
        { lat: auction.lat!, lng: auction.lng! },
        { ...options, serviceUrl },
      )
      return observation ? applyAirQuality(context, observation) : context
    },
  }
}

export async function readAirQuality(
  point: { lat: number; lng: number },
  options: CamsAirQualityOptions,
): Promise<LocationAirQualityObservation | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const url = new URL(options.serviceUrl ?? DEFAULT_SERVICE_URL)
  url.searchParams.set('latitude', point.lat.toFixed(5))
  url.searchParams.set('longitude', point.lng.toFixed(5))
  url.searchParams.set('current', CURRENT_FIELDS.join(','))
  url.searchParams.set('timezone', 'UTC')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let payload: AirQualityResponse
  try {
    const res = await fetchImpl(url.toString(), { signal: controller.signal })
    if (!res.ok) throw new Error(`air quality service returned ${res.status}`)
    payload = await res.json() as AirQualityResponse
  } finally {
    clearTimeout(timer)
  }

  const current = payload.current
  if (!current) return null
  const index = numeric(current.european_aqi)
  const observation: LocationAirQualityObservation = {
    index,
    level: airQualityLevel(index),
    particulateMatter10: numeric(current.pm10),
    particulateMatter25: numeric(current.pm2_5),
    nitrogenDioxide: numeric(current.nitrogen_dioxide),
    ozone: numeric(current.ozone),
    observedAt: observedAtIso(current.time),
    sourceLabel: SOURCE.label,
    sourceUrl: SOURCE.sourceUrl,
    checkedAt: options.checkedAt,
  }
  // A response whose grid cell carries no value at all is indistinguishable
  // from "outside the model domain" and would render as an empty card.
  const hasAnyValue = observation.index != null
    || observation.particulateMatter10 != null
    || observation.particulateMatter25 != null
    || observation.nitrogenDioxide != null
    || observation.ozone != null
  return hasAnyValue ? observation : null
}

/** European Air Quality Index bands as published by the EEA. */
export function airQualityLevel(index: number | null): LocationAirQualityLevel {
  if (index == null) return 'unknown'
  if (index <= 20) return 'good'
  if (index <= 40) return 'fair'
  if (index <= 60) return 'moderate'
  if (index <= 80) return 'poor'
  if (index <= 100) return 'very_poor'
  return 'extremely_poor'
}

export function applyAirQuality(
  context: LocationContext,
  observation: LocationAirQualityObservation,
): LocationContext {
  const environment = { ...context.environment, airQuality: observation }
  const riskSignals = new Set(environment.riskSignals)
  // Only the bands the EEA describes as harmful to the general population, so
  // an ordinary urban 'moderate' does not read as a defect of the property.
  if (observation.level === 'poor' || observation.level === 'very_poor' || observation.level === 'extremely_poor') {
    riskSignals.add(`air_quality_${observation.level}`)
  }
  environment.riskSignals = [...riskSignals]

  return {
    ...context,
    environment,
    source: {
      ...context.source,
      label: `${context.source.label} + ${SOURCE.label}`,
      licenseNote: `${context.source.licenseNote} ${SOURCE.licenseNote}`,
    },
  }
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The request asks for `timezone=UTC`, but the reply states the hour without a
 *  zone ('2026-07-29T13:00'), which any reader would parse as local time and so
 *  shift by the offset. Store the instant it actually is. */
function observedAtIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  return /(z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`
}
