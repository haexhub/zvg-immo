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
 * Resolve auctions that share a cross-platform identity key (Aktenzeichen or
 * the FR address fingerprint). Several auctions of ONE platform under the
 * same key are distinct lots of one case (e.g. agi lotti of one procedura,
 * several Bulgarian announcements of one enforcement case) and all survive.
 * Across platforms exactly one platform keeps its lots: the one listing the
 * most lots, so a portal that splits the case into lots is never reduced to
 * another portal's single summary record. Only on a tie in lot count does
 * the richest record (completenessScore) decide — rather than whichever
 * platform happens to be registered/crawled first.
 */
function resolveKeyGroup(group: readonly Auction[]): Auction[] {
  const byPlatform = new Map<string, Auction[]>()
  for (const a of group) {
    const lots = byPlatform.get(a.platform)
    if (lots) lots.push(a)
    else byPlatform.set(a.platform, [a])
  }
  const richest = (lots: readonly Auction[]) => Math.max(...lots.map(completenessScore))
  let winner: Auction[] = []
  for (const lots of byPlatform.values()) {
    if (lots.length > winner.length || (lots.length === winner.length && richest(lots) > richest(winner))) {
      winner = lots
    }
  }
  return winner
}

/**
 * Collapse the merged auctions of every platform covering one region so the
 * same real-world sale shows up once.
 */
export function dedupeRegionAuctions(regionAuctions: readonly Auction[]): Auction[] {
  const pfSeen = new Set<string>()
  const keyGroups = new Map<string, Auction[]>()
  const auctions: Auction[] = []
  for (const a of regionAuctions) {
    // {platform, externalId} is checked first and unconditionally so
    // platform-internal uniqueness is always preserved, independently of the
    // cross-platform matching below.
    const pfKey = `pf|${a.platform}|${a.externalId}`
    if (pfSeen.has(pfKey)) continue
    pfSeen.add(pfKey)
    // Overlapping platforms (e.g. zvg-portal + zvbawü both list the same BW
    // property) would otherwise produce duplicate pins and list rows. Match
    // them by a normalized {authority, caseNumber} key — the Aktenzeichen is
    // the court's own case number and is stable across portals. French
    // judicial-sale sources never publish it, yet frequently cross-publish
    // the exact same sale, so they fall back to a {postal code, house number,
    // date} fingerprint (frAddressDateKey).
    const az = a.caseNumber.trim().toLowerCase().replace(/\s+/g, ' ')
    const ag = a.authority.trim().toLowerCase()
    const key = az && ag ? `az|${ag}|${az}` : frAddressDateKey(a)
    if (!key) {
      auctions.push(a)
      continue
    }
    const group = keyGroups.get(key)
    if (group) group.push(a)
    else keyGroups.set(key, [a])
  }
  for (const group of keyGroups.values()) auctions.push(...resolveKeyGroup(group))
  return auctions
}
