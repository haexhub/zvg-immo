import type {
  Attachment,
  Auction,
  AuctionExtraction,
  AuctionInsights,
  CuratedPhoto,
  PlanningNotes,
  PhotoCategory,
} from '~/types/auction'
import type { Condition } from '~/lib/condition'
import type { Feature } from '~/lib/features'
import type { PropertyType } from '~/lib/property-type'
import { getPool } from './db'
import { cacheKey } from './verkehrswert-cache'

export interface AuctionRecord {
  auction: Auction
  detailsId: number | null
  detailsVersion: number | null
  artifactVersionId: number | null
}

interface AuctionRecordRow {
  platform: string
  external_id: string
  country: string
  region: string
  authority: string
  case_number: string
  title: string | null
  auction_date_iso: Date | string | null
  auction_date_text: string | null
  cancelled: boolean
  current_address: string | null
  current_description: string | null
  current_photo_count: number | null
  current_thumbnail_url: string | null
  current_lat: string | number | null
  current_lng: string | number | null
  details_id: string | number | null
  details_version: number | null
  artifact_version_id: string | number | null
  extracted_at: Date | string | null
  property_type: PropertyType | null
  land_area_sqm: string | number | null
  living_area_sqm: string | number | null
  rooms: string | number | null
  bedrooms: string | number | null
  bathrooms: string | number | null
  floor: string | null
  bathroom_has_tub: boolean | null
  bathroom_has_shower: boolean | null
  heating: string | null
  units: number | null
  year_built: number | null
  last_renovation_year: number | null
  market_value: string | number | null
  currency: string | null
  market_value_eur: string | number | null
  market_value_text: string | null
  condition: Condition | null
  features: Feature[] | null
  insights: AuctionInsights | null
  planning_notes: PlanningNotes | null
  renovation_notes: string | null
  starting_bid: string | number | null
  current_bid: string | number | null
  source_security_deposit: string | number | null
  security_deposit: string | number | null
  bidding_notes: string | null
  extraction_source: 'rules' | 'llm' | null
  extraction_confidence: 'high' | 'low' | null
  llm_analyzed_at: Date | string | null
  document_summary: string | null
  source_living_area_sqm: string | number | null
  source_land_area_sqm: string | number | null
  source_rooms: string | number | null
  pdf_url: string | null
  pdf_url_upstream: string | null
  detail_url: string | null
  detail_url_upstream: string | null
  attachments: Attachment[] | null
  photo_urls: string[] | null
  source_updated_iso: Date | string | null
  detail_fetched_at: Date | string | null
  llm_batch_job: string | null
  llm_failures: number | null
  llm_claimed_at: Date | string | null
  photos_checked_at: Date | string | null
  photo_failures: number | null
  photo_pipeline_version: number | null
}

interface AuctionPhotoRow {
  auction_details_id: string | number
  ordinal: number
  file: string
  category: PhotoCategory
  caption: string | null
  is_property_photo: boolean
}

const SELECT_SQL = `SELECT
  a.platform, a.external_id, a.country, a.region, a.authority, a.case_number,
  a.title, a.auction_date_iso, a.auction_date_text, a.cancelled,
  d.address AS current_address,
  d.description AS current_description,
  d.photo_count AS current_photo_count,
  d.thumbnail_url AS current_thumbnail_url,
  a.lat AS current_lat,
  a.lng AS current_lng,
  d.id AS details_id, d.version AS details_version, d.artifact_version_id, d.extracted_at,
  d.property_type, d.land_area_sqm, d.living_area_sqm, d.rooms,
  d.bedrooms, d.bathrooms, d.floor, d.bathroom_has_tub,
  d.bathroom_has_shower, d.heating, d.units, d.year_built,
  d.last_renovation_year, d.market_value, d.currency, d.market_value_eur,
  d.market_value_text, d.condition, d.features, d.insights, d.planning_notes,
  d.renovation_notes, d.starting_bid, d.current_bid,
  d.source_security_deposit, d.security_deposit, d.bidding_notes,
  d.extraction_source, d.extraction_confidence, d.llm_analyzed_at,
  d.document_summary, d.source_living_area_sqm, d.source_land_area_sqm,
  d.source_rooms,
  fs.pdf_url, fs.pdf_url_upstream, fs.detail_url, fs.detail_url_upstream,
  fs.attachments, fs.photo_urls, fs.source_updated_iso, fs.detail_fetched_at,
  fs.llm_batch_job, fs.llm_failures, fs.llm_claimed_at, fs.photos_checked_at,
  fs.photo_failures, fs.photo_pipeline_version
FROM auctions a
LEFT JOIN LATERAL (
  SELECT ad.* FROM auction_details ad
  WHERE ad.platform = a.platform AND ad.external_id = a.external_id AND ad.is_latest = true
) d ON true
LEFT JOIN auction_fetch_state fs
  ON fs.platform = a.platform AND fs.external_id = a.external_id`

function numberOrNull(value: string | number | null): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isoOrNull(value: Date | string | null): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : value
}

function extractionFromRow(row: AuctionRecordRow, photos: CuratedPhoto[]): AuctionExtraction | null {
  if (!row.extraction_source || !row.extraction_confidence || !row.extracted_at) return null
  const extraction: AuctionExtraction = {
    propertyType: row.property_type,
    landAreaSqm: numberOrNull(row.land_area_sqm),
    livingAreaSqm: numberOrNull(row.living_area_sqm),
    rooms: numberOrNull(row.rooms),
    units: row.units,
    securityDeposit: numberOrNull(row.security_deposit),
    biddingNotes: row.bidding_notes,
    source: row.extraction_source,
    confidence: row.extraction_confidence,
    at: isoOrNull(row.extracted_at)!,
    photos: photos.length > 0 ? photos : undefined,
    llmAnalyzedAt: isoOrNull(row.llm_analyzed_at) ?? undefined,
  }
  if (row.extraction_source === 'llm' || row.llm_analyzed_at != null) {
    extraction.bedrooms = numberOrNull(row.bedrooms)
    extraction.bathrooms = numberOrNull(row.bathrooms)
    extraction.floor = row.floor
    extraction.bathroomHasTub = row.bathroom_has_tub
    extraction.bathroomHasShower = row.bathroom_has_shower
    extraction.heating = row.heating
    extraction.yearBuilt = row.year_built
    extraction.lastRenovationYear = row.last_renovation_year
    extraction.condition = row.condition
    extraction.features = row.features ?? []
    extraction.insights = row.insights
    extraction.planningNotes = row.planning_notes
    extraction.renovationNotes = row.renovation_notes
    extraction.documentSummary = row.document_summary
    extraction.marketValueText = row.market_value_text
  }
  return extraction
}

function fromRow(row: AuctionRecordRow, photos: CuratedPhoto[]): AuctionRecord {
  const extraction = extractionFromRow(row, photos)
  return {
    detailsId: row.details_id == null ? null : Number(row.details_id),
    detailsVersion: row.details_version,
    artifactVersionId: row.artifact_version_id == null ? null : Number(row.artifact_version_id),
    auction: {
      platform: row.platform,
      externalId: row.external_id,
      country: row.country,
      region: row.region,
      authority: row.authority,
      caseNumber: row.case_number,
      title: row.title,
      address: row.current_address,
      marketValue: numberOrNull(row.market_value),
      currency: row.currency,
      marketValueEur: numberOrNull(row.market_value_eur),
      marketValueText: row.market_value_text,
      startingBid: numberOrNull(row.starting_bid),
      currentBid: numberOrNull(row.current_bid),
      sourceSecurityDeposit: numberOrNull(row.source_security_deposit),
      auctionDateIso: isoOrNull(row.auction_date_iso),
      auctionDateText: row.auction_date_text,
      cancelled: row.cancelled,
      sourceUpdatedIso: isoOrNull(row.source_updated_iso),
      pdfUrl: row.pdf_url,
      pdfUrlUpstream: row.pdf_url_upstream,
      detailUrl: row.detail_url,
      detailUrlUpstream: row.detail_url_upstream,
      attachments: row.attachments ?? [],
      photoUrls: row.photo_urls ?? undefined,
      description: row.current_description,
      photoCount: row.current_photo_count ?? 0,
      thumbnailUrl: row.current_thumbnail_url,
      sourceLivingAreaSqm: numberOrNull(row.source_living_area_sqm),
      sourceLandAreaSqm: numberOrNull(row.source_land_area_sqm),
      sourceRooms: numberOrNull(row.source_rooms),
      lat: numberOrNull(row.current_lat),
      lng: numberOrNull(row.current_lng),
      detailFetchedAt: isoOrNull(row.detail_fetched_at),
      extraction,
      processing: {
        llmBatchJob: row.llm_batch_job,
        llmFailures: row.llm_failures ?? 0,
        llmClaimedAt: isoOrNull(row.llm_claimed_at),
        photosCheckedAt: isoOrNull(row.photos_checked_at),
        photoFailures: row.photo_failures ?? 0,
        photoPipelineVersion: row.photo_pipeline_version,
      },
    },
  }
}

async function attachPhotos(rows: AuctionRecordRow[]): Promise<AuctionRecord[]> {
  const db = getPool()
  if (!db || rows.length === 0) return []
  const detailIds = rows.flatMap((row) => row.details_id == null ? [] : [row.details_id])
  const photosByDetails = new Map<string, CuratedPhoto[]>()
  if (detailIds.length > 0) {
    const result = await db.query<AuctionPhotoRow>(
      `SELECT auction_details_id, ordinal, file, category, caption, is_property_photo
       FROM auction_photos WHERE auction_details_id = ANY($1::bigint[])
       ORDER BY auction_details_id, ordinal`,
      [detailIds],
    )
    for (const photo of result.rows) {
      const key = String(photo.auction_details_id)
      const list = photosByDetails.get(key) ?? []
      list.push({
        file: photo.file,
        category: photo.category,
        caption: photo.caption,
        isPropertyPhoto: photo.is_property_photo,
      })
      photosByDetails.set(key, list)
    }
  }
  return rows.map((row) => fromRow(row, row.details_id == null ? [] : photosByDetails.get(String(row.details_id)) ?? []))
}

export async function readAuctionRecord(platform: string, externalId: string): Promise<AuctionRecord | null> {
  const db = getPool()
  if (!db) return null
  const result = await db.query<AuctionRecordRow>(`${SELECT_SQL} WHERE a.platform = $1 AND a.external_id = $2`, [platform, externalId])
  return (await attachPhotos(result.rows))[0] ?? null
}

export async function readAuctionRecords(country?: string, options: { includePhotos?: boolean } = {}): Promise<AuctionRecord[]> {
  const db = getPool()
  if (!db) return []
  const result = country
    ? await db.query<AuctionRecordRow>(`${SELECT_SQL} WHERE a.country = $1 ORDER BY a.platform, a.external_id`, [country])
    : await db.query<AuctionRecordRow>(`${SELECT_SQL} ORDER BY a.platform, a.external_id`)
  return options.includePhotos === false
    ? result.rows.map((row) => fromRow(row, []))
    : await attachPhotos(result.rows)
}

export async function readAuctionRecordMap(
  country?: string,
  options: { includePhotos?: boolean } = {},
): Promise<Map<string, AuctionRecord>> {
  const records = await readAuctionRecords(country, options)
  return new Map(records.map((record) => [cacheKey(record.auction.platform, record.auction.externalId), record]))
}
