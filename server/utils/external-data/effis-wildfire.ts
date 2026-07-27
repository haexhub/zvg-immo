import { readFile } from 'node:fs/promises'
import type { Auction, HazardAssessment } from '~/types/auction'
import type { HazardAssessmentAdapter } from '~/server/tasks/external-enrichment'
import { readJsonCache, writeJsonCache } from '../json-cache'
import { distanceMeters } from './geo'
import { EXTERNAL_DATA_SOURCES } from './sources'

export interface EffisWildfireCell {
  lat: number
  lng: number
  radiusMeters: number
  severity?: HazardAssessment['severity']
  fwi?: number | null
  classLabel?: string | null
}

export interface EffisStaticWildfireRiskCache {
  generatedAt: string
  cells: EffisWildfireCell[]
}

export interface EffisCurrentFireDangerCache {
  generatedAt: string
  validFor: string
  ttlHours: number
  model: 'ecmwf' | 'meteo-france' | 'unknown'
  layer: string
  cells: EffisWildfireCell[]
}

export interface EffisWildfireCache {
  sourceVersion: string
  generatedAt: string
  staticRisk?: EffisStaticWildfireRiskCache | null
  currentFireDanger?: EffisCurrentFireDangerCache | null
}

export interface EffisWildfireEvaluationOptions {
  checkedAt?: string
  maxStaticRiskAgeDays?: number
  maxSampleDistanceMeters?: number
}

export interface EffisWildfireFileAdapterOptions extends EffisWildfireEvaluationOptions {
  cachePath: string
  sourceVersion?: string
}

export interface EffisWmsSamplePoint {
  id?: string
  lat: number
  lng: number
}

export interface ImportEffisCurrentFireDangerOptions {
  cachePath: string
  points: EffisWmsSamplePoint[]
  serviceUrl?: string
  sourceVersion?: string
  generatedAt?: string
  validFor?: string
  ttlHours?: number
  fetchImpl?: typeof fetch
}

export interface ImportEffisCurrentFireDangerSummary {
  cachePath: string
  serviceUrl: string
  sourceVersion: string
  generatedAt: string
  validFor: string
  requested: number
  sampled: number
}

const EFFIS_SOURCE = EXTERNAL_DATA_SOURCES.find((source) => source.id === 'copernicus-effis')!
const DEFAULT_CELL_RADIUS_METERS = 10_000
const DEFAULT_SAMPLE_DISTANCE_METERS = 12_000
const DEFAULT_CURRENT_TTL_HOURS = 36
export const DEFAULT_EFFIS_STATIC_RISK_MAX_CACHE_AGE_DAYS = 400
export const EFFIS_WMS_URL = 'https://maps.effis.emergency.copernicus.eu/gwis'
export const EFFIS_FIRE_DANGER_LAYER = 'ecmwf.fwi'

export async function readEffisWildfireCache(path: string, sourceVersion?: string): Promise<EffisWildfireCache> {
  return loadEffisWildfireCache(await readFile(path, 'utf8'), { sourceVersion })
}

export function loadEffisWildfireCache(
  content: string,
  options: { sourceVersion?: string } = {},
): EffisWildfireCache {
  const parsed = JSON.parse(content) as unknown
  if (!parsed || typeof parsed !== 'object') return emptyCache(options.sourceVersion)
  const candidate = parsed as Partial<EffisWildfireCache>
  return {
    sourceVersion: options.sourceVersion || stringValue(candidate.sourceVersion) || 'unknown',
    generatedAt: stringValue(candidate.generatedAt) || new Date().toISOString(),
    staticRisk: normalizeStaticRisk(candidate.staticRisk),
    currentFireDanger: normalizeCurrentFireDanger(candidate.currentFireDanger),
  }
}

export function buildEffisWildfireHazardAssessments(
  auction: Auction,
  cache: EffisWildfireCache,
  options: EffisWildfireEvaluationOptions = {},
): HazardAssessment[] {
  if (auction.lat == null || auction.lng == null) return []
  const checkedAt = options.checkedAt ?? new Date().toISOString()
  const assessments: HazardAssessment[] = []
  const staticRisk = buildStaticWildfireRiskAssessment(auction, cache, {
    ...options,
    checkedAt,
  })
  if (staticRisk) assessments.push(staticRisk)
  const currentDanger = buildCurrentFireDangerAssessment(auction, cache, {
    ...options,
    checkedAt,
  })
  if (currentDanger) assessments.push(currentDanger)
  return assessments
}

export function buildStaticWildfireRiskAssessment(
  auction: Auction,
  cache: EffisWildfireCache,
  options: EffisWildfireEvaluationOptions = {},
): HazardAssessment | null {
  if (auction.lat == null || auction.lng == null) return null
  const checkedAt = options.checkedAt ?? new Date().toISOString()
  const staticRisk = cache.staticRisk
  if (!staticRisk || staticRisk.cells.length === 0) {
    return assessment('unknown', 'unknown', null, checkedAt, 'Copernicus EFFIS wildfire risk')
  }
  if (isStale(staticRisk.generatedAt, checkedAt, options.maxStaticRiskAgeDays)) {
    return assessment('unknown', 'unknown', null, checkedAt, 'Copernicus EFFIS wildfire risk', true)
  }

  const nearest = nearestCell(auction, staticRisk.cells, options.maxSampleDistanceMeters ?? DEFAULT_SAMPLE_DISTANCE_METERS)
  if (!nearest) return assessment('unknown', 'unknown', null, checkedAt, 'Copernicus EFFIS wildfire risk')
  const severity = severityForCell(nearest.cell)
  const elevated = severity === 'high' || severity === 'very_high'
  return assessment(
    elevated ? 'inside' : 'unknown',
    severity,
    nearest.distanceMeters,
    checkedAt,
    'Copernicus EFFIS wildfire risk',
  )
}

export function buildCurrentFireDangerAssessment(
  auction: Auction,
  cache: EffisWildfireCache,
  options: EffisWildfireEvaluationOptions = {},
): HazardAssessment | null {
  if (auction.lat == null || auction.lng == null) return null
  const checkedAt = options.checkedAt ?? new Date().toISOString()
  const current = cache.currentFireDanger
  if (!current || current.cells.length === 0) {
    return assessment('unknown', 'unknown', null, checkedAt, 'Copernicus EFFIS fire danger forecast')
  }
  if (isStaleHours(current.generatedAt, checkedAt, current.ttlHours)) {
    return assessment('unknown', 'unknown', null, checkedAt, 'Copernicus EFFIS fire danger forecast', true)
  }

  const nearest = nearestCell(auction, current.cells, options.maxSampleDistanceMeters ?? DEFAULT_SAMPLE_DISTANCE_METERS)
  if (!nearest) return assessment('unknown', 'unknown', null, checkedAt, 'Copernicus EFFIS fire danger forecast')
  const severity = severityForCell(nearest.cell)
  const elevated = severity === 'high' || severity === 'very_high'
  return assessment(
    elevated ? 'inside' : 'unknown',
    severity,
    nearest.distanceMeters,
    checkedAt,
    'Copernicus EFFIS fire danger forecast',
  )
}

export async function createEffisWildfireFileAdapter(
  options: EffisWildfireFileAdapterOptions,
): Promise<HazardAssessmentAdapter> {
  const cache = await readEffisWildfireCache(options.cachePath, options.sourceVersion)
  return {
    id: 'effis-wildfire-file-cache',
    sourceVersion: options.sourceVersion ?? cache.sourceVersion,
    supports: (auction) => auction.lat != null && auction.lng != null,
    async assess(auction) {
      return buildEffisWildfireHazardAssessments(auction, cache, options)
    },
  }
}

export async function importEffisCurrentFireDangerCache(
  options: ImportEffisCurrentFireDangerOptions,
): Promise<ImportEffisCurrentFireDangerSummary> {
  const serviceUrl = options.serviceUrl?.trim() || EFFIS_WMS_URL
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const validFor = options.validFor ?? generatedAt.slice(0, 10)
  const sourceVersion = options.sourceVersion?.trim() || `effis-ecmwf-fwi-${validFor}`
  const ttlHours = options.ttlHours ?? DEFAULT_CURRENT_TTL_HOURS
  const fetchImpl = options.fetchImpl ?? fetch
  const cells: EffisWildfireCell[] = []

  for (const point of options.points) {
    const fwi = await fetchEffisFwiSample(fetchImpl, serviceUrl, point, validFor)
    if (fwi == null) continue
    cells.push({
      lat: point.lat,
      lng: point.lng,
      radiusMeters: DEFAULT_CELL_RADIUS_METERS,
      fwi,
      severity: severityFromFwi(fwi),
      classLabel: classLabelFromFwi(fwi),
    })
  }

  const existing = await readJsonCache<EffisWildfireCache>(
    options.cachePath,
    () => emptyCache(sourceVersion),
    'effis-wildfire',
  )
  const cache: EffisWildfireCache = {
    ...existing,
    sourceVersion,
    generatedAt,
    currentFireDanger: {
      generatedAt,
      validFor,
      ttlHours,
      model: 'ecmwf',
      layer: EFFIS_FIRE_DANGER_LAYER,
      cells,
    },
  }
  await writeJsonCache(options.cachePath, cache)

  return {
    cachePath: options.cachePath,
    serviceUrl,
    sourceVersion,
    generatedAt,
    validFor,
    requested: options.points.length,
    sampled: cells.length,
  }
}

export function severityFromFwi(fwi: number): HazardAssessment['severity'] {
  if (!Number.isFinite(fwi) || fwi < 0) return 'unknown'
  if (fwi < 11.2) return 'low'
  if (fwi < 21.3) return 'medium'
  if (fwi < 38) return 'high'
  return 'very_high'
}

function classLabelFromFwi(fwi: number): string {
  if (fwi < 11.2) return 'low'
  if (fwi < 21.3) return 'moderate'
  if (fwi < 38) return 'high'
  if (fwi < 50) return 'very high'
  if (fwi < 70) return 'extreme'
  return 'very extreme'
}

function normalizeStaticRisk(input: unknown): EffisStaticWildfireRiskCache | null {
  if (!input || typeof input !== 'object') return null
  const candidate = input as Partial<EffisStaticWildfireRiskCache>
  return {
    generatedAt: stringValue(candidate.generatedAt) || new Date().toISOString(),
    cells: normalizeCells(candidate.cells),
  }
}

function normalizeCurrentFireDanger(input: unknown): EffisCurrentFireDangerCache | null {
  if (!input || typeof input !== 'object') return null
  const candidate = input as Partial<EffisCurrentFireDangerCache>
  return {
    generatedAt: stringValue(candidate.generatedAt) || new Date().toISOString(),
    validFor: stringValue(candidate.validFor) || stringValue(candidate.generatedAt) || new Date().toISOString(),
    ttlHours: positiveNumber(candidate.ttlHours) ?? DEFAULT_CURRENT_TTL_HOURS,
    model: candidate.model === 'ecmwf' || candidate.model === 'meteo-france' ? candidate.model : 'unknown',
    layer: stringValue(candidate.layer) || EFFIS_FIRE_DANGER_LAYER,
    cells: normalizeCells(candidate.cells),
  }
}

function normalizeCells(input: unknown): EffisWildfireCell[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((cell): EffisWildfireCell[] => {
    if (!cell || typeof cell !== 'object') return []
    const candidate = cell as Partial<EffisWildfireCell>
    const lat = finiteNumber(candidate.lat)
    const lng = finiteNumber(candidate.lng)
    if (lat == null || lng == null) return []
    return [{
      lat,
      lng,
      radiusMeters: positiveNumber(candidate.radiusMeters) ?? DEFAULT_CELL_RADIUS_METERS,
      severity: normalizeSeverity(candidate.severity) ?? undefined,
      fwi: finiteNumber(candidate.fwi),
      classLabel: stringValue(candidate.classLabel),
    }]
  })
}

function nearestCell(
  auction: Auction,
  cells: EffisWildfireCell[],
  maxDistanceMeters: number,
): { cell: EffisWildfireCell; distanceMeters: number } | null {
  const point = { lat: auction.lat!, lng: auction.lng! }
  const matches = cells
    .map((cell) => ({ cell, distanceMeters: distanceMeters(point, cell) }))
    .filter((match) => match.distanceMeters <= Math.min(match.cell.radiusMeters, maxDistanceMeters))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
  return matches[0] ?? null
}

function severityForCell(cell: EffisWildfireCell): HazardAssessment['severity'] {
  return normalizeSeverity(cell.severity) ?? (cell.fwi == null ? 'unknown' : severityFromFwi(cell.fwi))
}

function assessment(
  status: HazardAssessment['status'],
  severity: HazardAssessment['severity'],
  distance: number | null,
  checkedAt: string,
  sourceLabel: string,
  stale = false,
): HazardAssessment {
  return {
    hazard: 'wildfire',
    status,
    severity,
    distanceMeters: distance == null ? null : Math.round(distance),
    sourceLabel,
    sourceUrl: EFFIS_SOURCE.sourceUrl,
    checkedAt,
    ...(stale ? { stale: true } : {}),
  }
}

async function fetchEffisFwiSample(
  fetchImpl: typeof fetch,
  serviceUrl: string,
  point: EffisWmsSamplePoint,
  date: string,
): Promise<number | null> {
  const url = new URL(serviceUrl)
  const bboxSize = 0.05
  url.searchParams.set('SERVICE', 'WMS')
  url.searchParams.set('VERSION', '1.1.1')
  url.searchParams.set('REQUEST', 'GetFeatureInfo')
  url.searchParams.set('LAYERS', EFFIS_FIRE_DANGER_LAYER)
  url.searchParams.set('QUERY_LAYERS', EFFIS_FIRE_DANGER_LAYER)
  url.searchParams.set('STYLES', '')
  url.searchParams.set('SRS', 'EPSG:4326')
  url.searchParams.set('BBOX', [
    point.lng - bboxSize,
    point.lat - bboxSize,
    point.lng + bboxSize,
    point.lat + bboxSize,
  ].join(','))
  url.searchParams.set('WIDTH', '3')
  url.searchParams.set('HEIGHT', '3')
  url.searchParams.set('X', '1')
  url.searchParams.set('Y', '1')
  url.searchParams.set('INFO_FORMAT', 'application/json')
  url.searchParams.set('FEATURE_COUNT', '1')
  url.searchParams.set('TIME', date)

  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`EFFIS fire danger request failed: ${response.status} ${response.statusText}`)
  return fwiFromFeatureInfo(await response.json())
}

function fwiFromFeatureInfo(input: unknown): number | null {
  return fwiFromFeatureInfoValue(input, true)
}

function fwiFromFeatureInfoValue(input: unknown, allowPrimitive: boolean): number | null {
  if (allowPrimitive) {
    const direct = numericValue(input)
    if (direct != null) return direct
  }
  const stack = [input]
  while (stack.length > 0) {
    const value = stack.pop()
    if (value == null) continue
    if (Array.isArray(value)) {
      stack.push(...value)
      continue
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>
      for (const key of ['fwi', 'FWI', 'value', 'GRAY_INDEX', 'Pixel Value']) {
        const parsed = numericValue(record[key])
        if (parsed != null) return parsed
      }
      stack.push(...Object.values(record))
    }
  }
  return null
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isStale(generatedAt: string, checkedAt: string, maxAgeDays: number | undefined): boolean {
  if (maxAgeDays == null) return false
  return isStaleMs(generatedAt, checkedAt, maxAgeDays * 24 * 60 * 60 * 1000)
}

function isStaleHours(generatedAt: string, checkedAt: string, maxAgeHours: number): boolean {
  return isStaleMs(generatedAt, checkedAt, maxAgeHours * 60 * 60 * 1000)
}

function isStaleMs(generatedAt: string, checkedAt: string, maxAgeMs: number): boolean {
  const generatedTime = Date.parse(generatedAt)
  const checkedTime = Date.parse(checkedAt)
  if (!Number.isFinite(generatedTime)) return true
  if (!Number.isFinite(checkedTime)) return true
  return checkedTime - generatedTime > maxAgeMs
}

function normalizeSeverity(input: unknown): HazardAssessment['severity'] | null {
  if (input === 'low' || input === 'medium' || input === 'high' || input === 'very_high' || input === 'unknown') return input
  if (typeof input !== 'string') return null
  const normalized = input.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (['very_high', 'veryhigh', 'extreme', 'very_extreme'].includes(normalized)) return 'very_high'
  if (normalized === 'high') return 'high'
  if (['medium', 'moderate'].includes(normalized)) return 'medium'
  if (normalized === 'low') return 'low'
  return null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function positiveNumber(value: unknown): number | null {
  const number = finiteNumber(value)
  return number != null && number > 0 ? number : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function emptyCache(sourceVersion: string | undefined): EffisWildfireCache {
  return {
    sourceVersion: sourceVersion ?? 'unknown',
    generatedAt: new Date().toISOString(),
  }
}
