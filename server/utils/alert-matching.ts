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
import { listCountries } from '../crawlers/registry'
import { getServiceClient } from './supabase'
import { sendMail } from './mailer'

/** Converts saved_searches.filters (the raw route.query object pages/index.vue
 *  POSTs, see lib/auction-filters.ts's header comment) into the AuctionFilters
 *  shape filterAuctions() expects — mirrors pages/index.vue's own
 *  query-param → ref → AuctionFilters pipeline, just server-side against a
 *  stored jsonb blob instead of route.query. */
export function toAuctionFilters(stored: Record<string, unknown>): AuctionFilters {
  const str = (key: string): string => {
    const v = stored[key]
    return typeof v === 'string' ? v : ''
  }
  const num = (key: string): number | null => {
    const v = str(key)
    if (!v) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const list = (key: string): string[] => {
    const v = str(key)
    return v ? v.split(',').filter(Boolean) : []
  }

  const countries = list('country')
  const regionKeys = list('region') // `${countryCode}:${regionCode}` pairs

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

  return {
    countries,
    regionNameKeys,
    search: str('q'),
    court: str('court') || 'all',
    kategorie: str('kat') || 'all',
    onlyWithPhotos: str('photos') === '1',
    includeAufgehoben: str('aufgehoben') === '1',
    priceMin: num('priceMin'),
    priceMax: num('priceMax'),
    landMin: num('landMin'),
    landMax: num('landMax'),
    livMin: num('livMin'),
    livMax: num('livMax'),
  }
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
  const matched = filterAuctions(auctions, filters)
  if (matched.length === 0) return

  const { data: existing, error: existingError } = await supabase
    .from('notified_matches')
    .select('platform, zvg_id')
    .eq('alert_subscription_id', subscriptionId)
  if (existingError) {
    console.warn(`[alert-matching] load notified_matches failed: ${existingError.message}`)
    return
  }
  const notified = new Set((existing ?? []).map((r) => `${r.platform}:${r.zvg_id}`))
  const fresh = matched.filter((a) => !notified.has(`${a.platform}:${a.zvgId}`))
  if (fresh.length === 0) return

  const { error: insertError } = await supabase
    .from('notified_matches')
    .insert(fresh.map((a) => ({ alert_subscription_id: subscriptionId, platform: a.platform, zvg_id: a.zvgId })))
  if (insertError) {
    console.warn(`[alert-matching] insert notified_matches failed: ${insertError.message}`)
    return
  }

  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(userId)
  const email = userData?.user?.email
  if (userError || !email) {
    console.warn(`[alert-matching] no email for user ${userId}: ${userError?.message ?? 'missing'}`)
    return
  }

  for (const a of fresh) {
    try {
      await sendMail({
        to: email,
        subject: `Neue Auktion: ${a.objekt ?? a.aktenzeichen}`,
        text: buildMailBody(a),
      })
    } catch (err) {
      console.warn(`[alert-matching] mail send failed for ${a.platform}/${a.zvgId}: ${(err as Error).message}`)
    }
  }
}

function buildMailBody(a: Auction): string {
  const lines = [`Amtsgericht: ${a.amtsgericht}`, `Aktenzeichen: ${a.aktenzeichen}`]
  if (a.verkehrswertEur != null) lines.push(`Verkehrswert: ${a.verkehrswertEur.toLocaleString('de-DE')} €`)
  if (a.terminText) lines.push(`Termin: ${a.terminText}`)
  if (a.detailUrl) lines.push(`Details: ${a.detailUrl}`)
  return lines.join('\n')
}
