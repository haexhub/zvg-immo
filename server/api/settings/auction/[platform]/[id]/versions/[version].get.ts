// Full field values for one extraction version (docs/plans/2026-08-08-
// admin-auktions-technikseite.md, WP-5's diff). Deliberately separate from
// the technical overview endpoint's lightweight extractionHistory rows
// (metadata only) — fetched on demand for just the two versions an admin
// picked to compare, not preloaded for every version on every page load.

import { isSafePathSegment } from '~/server/utils/path-segment'
import { readAuctionDetailsAtVersion } from '~/server/utils/auction-details'

export default defineEventHandler(async (event) => {
  const platform = String(getRouterParam(event, 'platform') ?? '')
  const id = String(getRouterParam(event, 'id') ?? '')
  const versionParam = String(getRouterParam(event, 'version') ?? '')
  const version = Number(versionParam)
  if (!isSafePathSegment(platform) || !isSafePathSegment(id) || !Number.isInteger(version)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid platform/id/version' })
  }

  const row = await readAuctionDetailsAtVersion(platform, id, version)
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'version not found' })
  }

  return {
    version: row.version,
    address: row.address,
    description: row.description,
    propertyType: row.property_type,
    landAreaSqm: row.land_area_sqm,
    livingAreaSqm: row.living_area_sqm,
    rooms: row.rooms,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    floor: row.floor,
    bathroomHasTub: row.bathroom_has_tub,
    bathroomHasShower: row.bathroom_has_shower,
    heating: row.heating,
    units: row.units,
    yearBuilt: row.year_built,
    lastRenovationYear: row.last_renovation_year,
    marketValue: row.market_value,
    currency: row.currency,
    marketValueEur: row.market_value_eur,
    marketValueText: row.market_value_text,
    condition: row.condition,
    features: row.features,
    insights: row.insights,
    planningNotes: row.planning_notes,
    renovationNotes: row.renovation_notes,
    startingBid: row.starting_bid,
    currentBid: row.current_bid,
    sourceSecurityDeposit: row.source_security_deposit,
    securityDeposit: row.security_deposit,
    biddingNotes: row.bidding_notes,
    photoCount: row.photo_count,
    extractionSource: row.extraction_source,
    extractionConfidence: row.extraction_confidence,
    documentSummary: row.document_summary,
    extractionTexts: row.extraction_texts,
    sourceLivingAreaSqm: row.source_living_area_sqm,
    sourceLandAreaSqm: row.source_land_area_sqm,
    sourceRooms: row.source_rooms,
  }
})
