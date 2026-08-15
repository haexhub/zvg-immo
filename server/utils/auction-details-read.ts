import { sql } from 'drizzle-orm'
import type { Auction, AuctionExtraction, CuratedPhoto, PhotoCategory } from '~/types/auction'
import { extractTranslatableExtractionTexts } from '~/lib/extraction-translation'
import { normalizePhoto } from '~/lib/photo'
import { getDb } from './db'
import { cacheKey } from './verkehrswert-cache'
import { normalizeDescriptionText } from './description-normalization'
import { withDerivedExtractionFields } from './extract/merge-llm-result'

export interface AuctionDetailsRow {
  id: number; platform: string; external_id: string; version: number; artifact_version_id: number | null
  created_at: string; extracted_at: string; address: string | null; description: string | null; property_type: string | null
  land_area_sqm: number | null; living_area_sqm: number | null; rooms: number | null; bedrooms: number | null; bathrooms: number | null
  floor: string | null; bathroom_has_tub: boolean | null; bathroom_has_shower: boolean | null; heating: string | null; units: number | null
  year_built: number | null; last_renovation_year: number | null; market_value: number | null; currency: string | null; market_value_eur: number | null
  condition: unknown; features: string[] | null; insights: unknown; planning_notes: unknown; renovation_notes: string | null
  starting_bid: number | null; current_bid: number | null; source_security_deposit: number | null; security_deposit: number | null
  bidding_notes: string | null; photo_count: number; thumbnail_url: string | null; extraction_source: string | null; extraction_confidence: string | null
  llm_analyzed_at: string | null; document_summary: string | null; extraction_texts: unknown; source_living_area_sqm: number | null
  source_land_area_sqm: number | null; source_rooms: number | null; market_value_text: string | null; is_latest: boolean; is_trial: boolean
  llm_provider: string | null; llm_model: string | null; llm_profile_id: string | null; run_trigger: string | null; llm_duration_ms: number | null
}
export interface AuctionPhotoRow { ordinal: number; file: string; category: PhotoCategory; caption: string | null; is_property_photo: boolean; appeal_score: number | null }
export type Raw<T> = T & Record<string, unknown>

export const VALUE_COLUMNS = [
  ['artifact_version_id', 'bigint'], ['address', 'text'], ['description', 'text'], ['property_type', 'text'], ['land_area_sqm', 'numeric'],
  ['living_area_sqm', 'numeric'], ['rooms', 'numeric'], ['bedrooms', 'numeric'], ['bathrooms', 'numeric'], ['floor', 'text'],
  ['bathroom_has_tub', 'boolean'], ['bathroom_has_shower', 'boolean'], ['heating', 'text'], ['units', 'integer'], ['year_built', 'integer'],
  ['last_renovation_year', 'integer'], ['market_value', 'numeric'], ['currency', 'text'], ['market_value_eur', 'numeric'], ['condition', 'jsonb'],
  ['features', 'text[]'], ['insights', 'jsonb'], ['planning_notes', 'jsonb'], ['renovation_notes', 'text'], ['starting_bid', 'numeric'],
  ['current_bid', 'numeric'], ['source_security_deposit', 'numeric'], ['security_deposit', 'numeric'], ['bidding_notes', 'text'], ['photo_count', 'integer'],
  ['thumbnail_url', 'text'], ['extraction_source', 'text'], ['extraction_confidence', 'text'], ['document_summary', 'text'], ['extraction_texts', 'jsonb'],
  ['source_living_area_sqm', 'numeric'], ['source_land_area_sqm', 'numeric'], ['source_rooms', 'numeric'], ['market_value_text', 'text'],
] as const satisfies ReadonlyArray<readonly [string, string]>
export type ValueColumn = (typeof VALUE_COLUMNS)[number][0]

const json = (value: unknown): string | null => value === undefined ? null : JSON.stringify(value)
export function pgTextArrayLiteral(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`
}
export function auctionDetailsValues(auction: Auction, extraction: AuctionExtraction | null): Record<ValueColumn, unknown> {
  const e = extraction ? withDerivedExtractionFields(extraction) : null
  const texts = e ? extractTranslatableExtractionTexts(e) : null
  return {
    artifact_version_id: null, address: auction.address, description: normalizeDescriptionText(auction.description), property_type: e?.propertyType ?? null,
    land_area_sqm: e?.landAreaSqm ?? null, living_area_sqm: e?.livingAreaSqm ?? null, rooms: e?.rooms ?? null, bedrooms: e?.bedrooms ?? null,
    bathrooms: e?.bathrooms ?? null, floor: e?.floor ?? null, bathroom_has_tub: e?.bathroomHasTub ?? null, bathroom_has_shower: e?.bathroomHasShower ?? null,
    heating: e?.heating ?? null, units: e?.units ?? null, year_built: e?.yearBuilt ?? null, last_renovation_year: e?.lastRenovationYear ?? null,
    market_value: auction.marketValue ?? null, currency: auction.currency ?? null, market_value_eur: auction.marketValueEur, condition: json(e?.condition),
    features: e?.features ?? null, insights: json(e?.insights), planning_notes: json(e?.planningNotes), renovation_notes: e?.renovationNotes ?? null,
    starting_bid: auction.startingBid ?? null, current_bid: auction.currentBid ?? null, source_security_deposit: auction.sourceSecurityDeposit ?? null,
    security_deposit: e?.securityDeposit ?? null, bidding_notes: e?.biddingNotes ?? null, photo_count: auction.photoCount, thumbnail_url: auction.thumbnailUrl,
    extraction_source: e?.source ?? null, extraction_confidence: e?.confidence ?? null, document_summary: e?.documentSummary ?? null, extraction_texts: json(texts),
    source_living_area_sqm: auction.sourceLivingAreaSqm ?? null, source_land_area_sqm: auction.sourceLandAreaSqm ?? null,
    source_rooms: auction.sourceRooms ?? null, market_value_text: e?.marketValueText ?? auction.marketValueText,
  }
}
export const normalizedPhotos = (extraction: AuctionExtraction | null): CuratedPhoto[] => (extraction?.photos ?? []).map(normalizePhoto)
export function photoRowsEqual(rows: AuctionPhotoRow[], photos: CuratedPhoto[]): boolean {
  return rows.length === photos.length && rows.every((row, index) => {
    const photo = photos[index]
    return !!photo && row.ordinal === index && row.file === photo.file && row.category === photo.category && row.caption === photo.caption && row.is_property_photo === photo.isPropertyPhoto && row.appeal_score === (photo.appealScore ?? null)
  })
}
export async function readAuctionPhotos(auctionDetailsId: number): Promise<CuratedPhoto[]> {
  const db = getDb(); if (!db) return []
  const { rows } = await db.execute<Raw<AuctionPhotoRow>>(sql`SELECT ordinal, file, category, caption, is_property_photo, appeal_score FROM auction_photos WHERE auction_details_id = ${auctionDetailsId} ORDER BY ordinal`)
  return rows.map((row) => ({ file: row.file, category: row.category, caption: row.caption, isPropertyPhoto: row.is_property_photo, ...(row.appeal_score == null ? {} : { appealScore: row.appeal_score }) }))
}
const latestCache = new Map<string, AuctionDetailsRow | null>()
export const invalidateAuctionDetailsCache = () => latestCache.clear()
export async function readLatestAuctionDetails(platform: string, externalId: string): Promise<AuctionDetailsRow | null> {
  const key = cacheKey(platform, externalId); const cached = latestCache.get(key); if (cached !== undefined) return cached
  const db = getDb(); if (!db) return null
  const { rows } = await db.execute<Raw<AuctionDetailsRow>>(sql`SELECT * FROM auction_details WHERE platform = ${platform} AND external_id = ${externalId} AND is_latest = true`)
  const row = rows[0] ?? null; if (row) latestCache.set(key, row); return row
}
export async function readAuctionDetailsAtVersion(platform: string, externalId: string, version: number): Promise<AuctionDetailsRow | null> {
  const db = getDb(); if (!db) return null
  const { rows } = await db.execute<Raw<AuctionDetailsRow>>(sql`SELECT * FROM auction_details WHERE platform = ${platform} AND external_id = ${externalId} AND version = ${version}`)
  return rows[0] ?? null
}
export const cacheLatestAuctionDetails = (platform: string, externalId: string, row: AuctionDetailsRow) => latestCache.set(cacheKey(platform, externalId), row)
