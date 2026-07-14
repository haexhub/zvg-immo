import type { RegionInfo } from '../types'

export const FR_BASE = 'https://www.licitor.com'
export const COUNTRY = 'fr'
export const PLATFORM_ID = 'fr-licitor'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

/** Licitor has no user-facing sub-region filter of its own — the "grandes
 *  régions" below are purely an internal listing/pagination split (see
 *  FR_LIST_REGIONS) that together cover all of France. */
export const FR_REGIONS: readonly RegionInfo[] = [
  { code: 'all', name: 'Frankreich' },
] as const

export const REGION_NAME = 'Frankreich'

/** The 6 "grande région" listing pages that together enumerate every
 *  upcoming judicial real-estate auction in France; each is paginated
 *  (see list.ts). Slugs taken from the site's own navigation. */
export const FR_LIST_REGIONS: readonly string[] = [
  'bretagne-grand-ouest',
  'centre-loire-limousin',
  'paris-et-ile-de-france',
  'regions-du-nord-est',
  'sud-est-mediterrannee',
  'sud-ouest-pyrenees',
] as const

/** robots.txt disallows /data/pub/doc/, /data/pub/media/ and /data/pub/04/
 *  for all crawlers (not just AI bots) — treat this as a hard boundary and
 *  never fetch documents from those paths. Only /data/pub/pic/ (photos) and
 *  ordinary listing/detail pages are fetched. Licitor detail pages don't
 *  link any PDFs outside those disallowed paths anyway (no cahier des
 *  charges is exposed), so attachments are always empty for this platform. */
export const DISALLOWED_DATA_PATHS = ['/data/pub/doc/', '/data/pub/media/', '/data/pub/04/'] as const
