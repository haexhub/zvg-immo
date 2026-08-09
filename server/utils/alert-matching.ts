// Matches a freshly-crawled region batch against every active alert
// subscription and emails the owner once per newly-seen match. Runs once per
// (country, region) refresh batch (see server/tasks/refresh.ts) and must
// never throw — a mail/DB hiccup here can't be allowed to block the crawl,
// same resilience stance as the rest of refresh.ts and history.ts.
//
// Scoping note: saved_searches.filters is jsonb, so the country/region
// selection inside it can't be prefiltered in SQL. This loads *all* active
// subscriptions on every call and relies on filterAuctions() (via
// scopeByCountryRegion()) to scope each subscription's own country/region
// selection against the current batch — acceptable at current scale, first
// thing to optimize (e.g. a GIN index on filters) if subscriber count grows.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Auction, CrawlResult } from '~/types/auction'
import { filterAuctions, type AuctionFilters } from '~/lib/auction-filters'
import { parseAuctionSearchFilters, unsupportedAlertFilterKeys } from '~/lib/auction-search-filter-contract'
import { listCountries } from '../crawlers/registry'
import { getServiceClient } from './supabase'
import { enqueueAlertDelivery } from './outbound-delivery'

/** Converts saved_searches.filters (the raw route.query object pages/index.vue
 *  POSTs, see lib/auction-filters.ts's header comment) into the AuctionFilters
 *  shape filterAuctions() expects — mirrors pages/index.vue's own
 *  query-param → ref → AuctionFilters pipeline, just server-side against a
 *  stored jsonb blob instead of route.query. */
export function toAuctionFilters(stored: Record<string, unknown>): AuctionFilters {
  const filters = parseAuctionSearchFilters(stored)
  const regionKeys = filters.regionKeys // `${countryCode}:${regionCode}` pairs

  let regionNameKeys: Set<string> | null = null
  if (regionKeys.length > 0) {
    const byCountry = new Map(listCountries().map((c) => [c.code, c]))
    const set = new Set<string>()
    for (const key of regionKeys) {
      const sep = key.indexOf(':')
      if (sep < 0) continue
      const countryCode = key.slice(0, sep)
      const regionCode = key.slice(sep + 1)
      const region = byCountry.get(countryCode)?.regions.find((r) => r.code === regionCode)
      if (region) set.add(`${countryCode}:${region.name}`)
    }
    regionNameKeys = set
  }

  return { ...filters, regionNameKeys }
}

interface SubscriptionRow {
  id: string
  user_id: string
  saved_searches: { filters: Record<string, unknown> } | { filters: Record<string, unknown> }[] | null
}

export async function matchAlerts(country: string, region: string, result: CrawlResult): Promise<void> {
  const supabase = getServiceClient()
  if (!supabase) return
  if (result.auctions.length === 0) return

  let subscriptions: SubscriptionRow[]
  try {
    const { data, error } = await supabase
      .from('alert_subscriptions')
      .select('id, user_id, saved_searches(filters)')
      .eq('enabled', true)
    if (error) {
      console.warn(`[alert-matching] load subscriptions failed: ${error.message}`)
      return
    }
    subscriptions = (data ?? []) as unknown as SubscriptionRow[]
  } catch (err) {
    console.warn(`[alert-matching] ${country}/${region}: ${(err as Error).message}`)
    return
  }

  for (const sub of subscriptions) {
    try {
      const savedSearch = Array.isArray(sub.saved_searches) ? sub.saved_searches[0] : sub.saved_searches
      if (!savedSearch) continue
      await processSubscription(supabase, sub.id, sub.user_id, savedSearch.filters, result.auctions)
    } catch (err) {
      console.warn(`[alert-matching] subscription ${sub.id}: ${(err as Error).message}`)
    }
  }
}

async function processSubscription(
  supabase: SupabaseClient,
  subscriptionId: string,
  userId: string,
  storedFilters: Record<string, unknown>,
  auctions: Auction[],
): Promise<void> {
  const filters = toAuctionFilters(storedFilters ?? {})
  const unsupported = unsupportedAlertFilterKeys(filters)
  if (unsupported.length) {
    // Old rows may predate the write-time validation.  Do not turn their
    // unsupported constraints into false-positive mail; a save/enable now
    // returns a clear 400 instead.
    console.warn(`[alert-matching] subscription ${subscriptionId}: unsupported filters: ${unsupported.join(', ')}`)
    return
  }
  const matched = filterAuctions(auctions, filters)
  if (matched.length === 0) return

  const { data: existing, error: existingError } = await supabase
    .from('notified_matches')
    .select('platform, external_id')
    .eq('alert_subscription_id', subscriptionId)
  if (existingError) {
    console.warn(`[alert-matching] load notified_matches failed: ${existingError.message}`)
    return
  }
  const notified = new Set((existing ?? []).map((r) => `${r.platform}:${r.external_id}`))
  const fresh = matched.filter((a) => !notified.has(`${a.platform}:${a.externalId}`))
  if (fresh.length === 0) return

  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(userId)
  const email = userData?.user?.email
  if (userError || !email) {
    console.warn(`[alert-matching] no email for user ${userId}: ${userError?.message ?? 'missing'}`)
    return
  }

  for (const a of fresh) {
    try {
      const queued = await enqueueAlertDelivery({
        to: email,
        subject: `Neue Auktion: ${a.title ?? a.caseNumber}`,
        text: buildMailBody(a),
        alertSubscriptionId: subscriptionId,
        platform: a.platform,
        externalId: a.externalId,
      })
      if (!queued) {
        console.warn(`[alert-matching] durable outbox unavailable for ${a.platform}/${a.externalId}`)
      }
    } catch (err) {
      console.warn(`[alert-matching] enqueue failed for ${a.platform}/${a.externalId}: ${(err as Error).message}`)
    }
  }
}

function buildMailBody(a: Auction): string {
  const lines = [`Amtsgericht: ${a.authority}`, `Aktenzeichen: ${a.caseNumber}`]
  if (a.marketValueEur != null) lines.push(`Verkehrswert: ${a.marketValueEur.toLocaleString('de-DE')} €`)
  if (a.auctionDateText) lines.push(`Termin: ${a.auctionDateText}`)
  if (a.detailUrl) lines.push(`Details: ${a.detailUrl}`)
  return lines.join('\n')
}
