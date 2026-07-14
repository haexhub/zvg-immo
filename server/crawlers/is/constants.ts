import type { RegionInfo } from '../types'

export const IS_BASE = 'https://island.is'
export const COUNTRY = 'is'
export const PLATFORM_ID = 'is-syslumenn'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

/** Public, unauthenticated GraphQL endpoint of the official island.is portal.
 *  The `getSyslumennAuctions` query (resolver annotated @BypassAuth in the
 *  open-source island.is monorepo) returns the nationwide feed of forced sales
 *  (nauðungarsölur) run by all 9 district commissioners (sýslumenn) in one
 *  call — no auth, no pagination. */
export const GRAPHQL_URL = `${IS_BASE}/api/graphql`

export const AUCTIONS_QUERY =
  'query{getSyslumennAuctions{office location auctionType lotType lotName lotId lotItems auctionDate auctionTime petitioners respondent publishText auctionTakesPlaceAt}}'

/** The commissioners aggregate nationwide behind a single feed — no per-office
 *  split needed. */
export const IS_REGIONS: readonly RegionInfo[] = [
  { code: 'all', name: 'Island' },
] as const

export const REGION_NAME = 'Island'

/** Asset class that marks a lot as real estate (as opposed to `Skip` = ship or
 *  `Lausafjármunir` = movables). Only these are kept. */
export const REAL_ESTATE_LOT_TYPE = 'Fasteign'

/** Auction stages whose Icelandic name marks the sale as already concluded.
 *  The feed is a rolling window that keeps completed cases around for a while;
 *  they are stale for an "upcoming auctions" view, so drop them. Matched as a
 *  substring, case-insensitive ("Sölu lokið" = sale completed). */
export const COMPLETED_STAGE_MARKER = 'lokið'
