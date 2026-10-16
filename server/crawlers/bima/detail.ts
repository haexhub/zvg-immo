import type { Auction } from '~/types/auction'
import { API_BASE, UA } from './constants'
import { indexIncluded, mapOffer, type SingleOfferResponse } from './list'

const FETCH_TIMEOUT_MS = 20_000

/**
 * Fast path for a permalink whose snapshot entry hasn't been written yet —
 * `GET /immo/real_estate_offers/<id>` returns the same {data, included}
 * shape as one item of the search response (verified live), just without
 * pagination `meta`, so it reuses mapOffer directly.
 */
export async function findOne(externalId: string, platformId: string): Promise<Auction | null> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(externalId)}`, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`bundesimmobilien.de detail HTTP ${res.status} for ${externalId}`)
  const body = (await res.json()) as SingleOfferResponse
  const byKey = indexIncluded(body.included ?? [])
  return mapOffer(body.data, byKey, platformId)
}
