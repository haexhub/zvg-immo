import { readFile } from 'node:fs/promises'
import type { Auction, HazardAssessment } from '~/types/auction'
import type { HazardAssessmentAdapter } from '~/server/tasks/external-enrichment'
import { EXTERNAL_DATA_SOURCES } from './sources'

export interface AvalancheServiceMetadata {
  country: string
  label: string
  sourceUrl: string
  endpointStatus: 'confirmed' | 'unconfirmed' | 'unsupported'
  notes?: string
}

export interface AvalancheDiscoveryCache {
  sourceVersion: string
  generatedAt: string
  services: AvalancheServiceMetadata[]
}

export interface AvalancheDiscoveryAdapterOptions {
  metadataPath: string
  checkedAt?: string
  maxCacheAgeDays?: number
  sourceVersion?: string
}

const EAWS_SOURCE = EXTERNAL_DATA_SOURCES.find((source) => source.id === 'eaws')!
const DEFAULT_MAX_CACHE_AGE_DAYS = 400

export async function readAvalancheDiscoveryCache(path: string, sourceVersion?: string): Promise<AvalancheDiscoveryCache> {
  return loadAvalancheDiscoveryCache(await readFile(path, 'utf8'), { sourceVersion })
}

export function loadAvalancheDiscoveryCache(
  content: string,
  options: { sourceVersion?: string } = {},
): AvalancheDiscoveryCache {
  const parsed = JSON.parse(content) as unknown
  if (!parsed || typeof parsed !== 'object') return emptyCache(options.sourceVersion)
  const candidate = parsed as Partial<AvalancheDiscoveryCache>
  return {
    sourceVersion: options.sourceVersion || stringValue(candidate.sourceVersion) || 'unknown',
    generatedAt: stringValue(candidate.generatedAt) || new Date().toISOString(),
    services: Array.isArray(candidate.services) ? candidate.services.flatMap(normalizeService) : [],
  }
}

export function buildAvalancheDiscoveryAssessment(
  auction: Auction,
  cache: AvalancheDiscoveryCache,
  options: { checkedAt?: string; maxCacheAgeDays?: number } = {},
): HazardAssessment | null {
  if (auction.lat == null || auction.lng == null) return null
  const checkedAt = options.checkedAt ?? new Date().toISOString()
  if (isStale(cache.generatedAt, checkedAt, options.maxCacheAgeDays ?? DEFAULT_MAX_CACHE_AGE_DAYS)) {
    return assessment(checkedAt, EAWS_SOURCE.label, EAWS_SOURCE.sourceUrl, true)
  }
  const service = cache.services.find((entry) => entry.country === auction.country.toLowerCase())
  if (!service || service.endpointStatus !== 'confirmed') {
    return assessment(checkedAt, service?.label ?? EAWS_SOURCE.label, service?.sourceUrl ?? EAWS_SOURCE.sourceUrl)
  }

  // WP5 deliberately does not infer avalanche safety from discovery metadata.
  // A real country adapter should replace this once an official public geodata
  // endpoint is confirmed and modeled.
  return assessment(checkedAt, service.label, service.sourceUrl)
}

export async function createAvalancheDiscoveryAdapter(
  options: AvalancheDiscoveryAdapterOptions,
): Promise<HazardAssessmentAdapter> {
  const cache = await readAvalancheDiscoveryCache(options.metadataPath, options.sourceVersion)
  return {
    id: 'avalanche-discovery-cache',
    sourceVersion: options.sourceVersion ?? cache.sourceVersion,
    supports: (auction) => auction.lat != null && auction.lng != null,
    async assess(auction) {
      const result = buildAvalancheDiscoveryAssessment(auction, cache, options)
      return result ? [result] : []
    },
  }
}

function assessment(
  checkedAt: string,
  sourceLabel: string,
  sourceUrl: string,
  stale = false,
): HazardAssessment {
  return {
    hazard: 'avalanche',
    status: 'unknown',
    severity: 'unknown',
    distanceMeters: null,
    sourceLabel,
    sourceUrl,
    checkedAt,
    ...(stale ? { stale: true } : {}),
  }
}

function normalizeService(input: unknown): AvalancheServiceMetadata[] {
  if (!input || typeof input !== 'object') return []
  const candidate = input as Partial<AvalancheServiceMetadata>
  const country = stringValue(candidate.country)?.toLowerCase()
  const label = stringValue(candidate.label)
  const sourceUrl = stringValue(candidate.sourceUrl)
  if (!country || !/^[a-z]{2}$/.test(country) || !label || !sourceUrl) return []
  const endpointStatus = candidate.endpointStatus === 'confirmed' || candidate.endpointStatus === 'unconfirmed'
    ? candidate.endpointStatus
    : 'unsupported'
  return [{
    country,
    label,
    sourceUrl,
    endpointStatus,
    notes: stringValue(candidate.notes) ?? undefined,
  }]
}

function isStale(generatedAt: string, checkedAt: string, maxAgeDays: number): boolean {
  const generatedTime = Date.parse(generatedAt)
  const checkedTime = Date.parse(checkedAt)
  if (!Number.isFinite(generatedTime)) return true
  if (!Number.isFinite(checkedTime)) return true
  return checkedTime - generatedTime > maxAgeDays * 24 * 60 * 60 * 1000
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function emptyCache(sourceVersion: string | undefined): AvalancheDiscoveryCache {
  return {
    sourceVersion: sourceVersion ?? 'unknown',
    generatedAt: new Date().toISOString(),
    services: [],
  }
}
