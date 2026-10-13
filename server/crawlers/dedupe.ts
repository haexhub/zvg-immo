import type { Auction } from '~/types/auction'

/**
 * French judicial-sale sources (licitor.com, avoventes.fr) never publish the
 * court's own case number, so both always have an empty {caseNumber}, yet
 * they frequently cross-publish the exact same sale (the same avocat
 * poursuivant submits to both platforms). Fall back to a normalized {postal
 * code, house number, sale date} fingerprint so that pair collapses to one
 * pin instead of showing twice. Scoped to country 'fr' only — other
 * countries with an empty caseNumber (AT, EE, LV, FI) have exactly one
 * registered platform each and must keep relying on {platform, externalId}.
 */
export function frAddressDateKey(a: Auction): string | null {
  if (a.country !== 'fr' || !a.address || !a.auctionDateIso) return null
  const postal = a.address.match(/\b\d{5}\b/)?.[0]
  if (!postal) return null
  // Strip the postal code before looking for a house number — otherwise a
  // postal-code-only address (no street number, e.g. a rural lieu-dit) would
  // match the postal code itself as "the house number", degenerating to a
  // {postal, postal, date} key that can falsely merge two distinct auctions
  // that only share a postal code and a sale date.
  const addressWithoutPostal = a.address.replace(new RegExp(`\\b${postal}\\b`), '')
  const houseNumber = addressWithoutPostal.match(/\b\d+[a-z]?(?:\s*(?:bis|ter|quater))?\b/i)?.[0]
  if (!houseNumber) return null
  return `fr-addr|${postal}|${houseNumber}|${a.auctionDateIso.slice(0, 10)}`
}

/**
 * Rough completeness score used to pick a winner when two platforms publish
 * the same real-world sale. Higher is richer — so when e.g. avoventes.fr has
 * a fuller record for a sale than licitor.com (or vice versa), the fuller one
 * survives instead of whichever platform happens to be registered first.
 */
export function completenessScore(a: Auction): number {
  return (
    (a.marketValueEur != null ? 1 : 0) +
    (a.title ? 1 : 0) +
    (a.address ? 1 : 0) +
    (a.auctionDateIso ? 1 : 0) +
    (a.description ? 1 : 0) +
    (a.sourceLivingAreaSqm != null || a.sourceLandAreaSqm != null ? 1 : 0) +
    (a.sourceRooms != null ? 1 : 0) +
    (a.lat != null ? 1 : 0) +
    Math.min(a.photoCount, 5)
  )
}

/**
 * Collapse the merged auctions of every platform covering one region so the
 * same real-world sale shows up once.
 */
export function dedupeRegionAuctions(regionAuctions: readonly Auction[]): Auction[] {
  // Overlapping platforms (e.g. zvg-portal + zvbawü both list the same BW
  // property) would otherwise produce duplicate pins and list rows. Dedup by
  // a normalized {authority, caseNumber} key — the Aktenzeichen is the
  // court's own case number and is stable across portals. Among auctions
  // sharing a key, keep the one with the richer record (completenessScore)
  // rather than whichever platform happens to be registered/crawled first.
  const azWinners = new Map<string, Auction>()
  const pfSeen = new Set<string>()
  const noAzAuctions: Auction[] = []
  for (const a of regionAuctions) {
    const az = a.caseNumber.trim().toLowerCase().replace(/\s+/g, ' ')
    const ag = a.authority.trim().toLowerCase()
    if (az && ag) {
      const key = `az|${ag}|${az}`
      const existing = azWinners.get(key)
      if (!existing || completenessScore(a) > completenessScore(existing)) {
        azWinners.set(key, a)
      }
      continue
    }
    // No court case number available — {platform, externalId} is checked
    // unconditionally so platform-internal uniqueness is always preserved,
    // independently of the cross-platform address+date matching below.
    const pfKey = `pf|${a.platform}|${a.externalId}`
    if (pfSeen.has(pfKey)) continue
    pfSeen.add(pfKey)
    noAzAuctions.push(a)
  }

  // French judicial-sale sources never publish the court's own case number,
  // yet frequently cross-publish the exact same sale — collapse auctions
  // sharing a {postal code, house number, date} fingerprint (frAddressDateKey)
  // to whichever has the richer record, but ONLY across different platforms.
  // Two same-platform auctions sharing that fingerprint are distinct lots
  // (e.g. two apartments in one seized building sold the same day) and must
  // both survive — grouping by platform first guards that.
  const addrGroups = new Map<string, Auction[]>()
  const auctions: Auction[] = []
  for (const a of noAzAuctions) {
    const key = frAddressDateKey(a)
    if (!key) {
      auctions.push(a)
      continue
    }
    const group = addrGroups.get(key)
    if (group) group.push(a)
    else addrGroups.set(key, [a])
  }
  for (const group of addrGroups.values()) {
    if (new Set(group.map((a) => a.platform)).size === 1) {
      auctions.push(...group)
    } else {
      auctions.push(group.reduce((best, a) => (completenessScore(a) > completenessScore(best) ? a : best)))
    }
  }
  auctions.push(...azWinners.values())
  return auctions
}
