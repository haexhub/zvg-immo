// Bridges the two photo representations that coexist in extraction_cache: the
// new structured CuratedPhoto and the bare filename strings older rows still
// hold. Instead of a data migration, every read site normalizes on the way
// out (applyExtractionToAuctions, the enrich write path, the objekt detail
// page). Shared by server and client, so it lives in lib/.

import type { CuratedPhoto, PhotoCategory } from '~/types/auction'

const CATEGORIES: readonly PhotoCategory[] = ['aussen', 'innen', 'grundriss', 'lageplan', 'sonstiges']
const VALID_CATEGORIES = new Set<string>(CATEGORIES)

/** A bare string becomes an uncategorised property photo; an object with an
 *  unknown/missing category falls back to 'sonstiges'. Idempotent. */
export function normalizePhoto(p: string | CuratedPhoto): CuratedPhoto {
  if (typeof p === 'string') {
    return { file: p, category: 'sonstiges', caption: null, isPropertyPhoto: true }
  }
  return {
    file: p.file,
    category: VALID_CATEGORIES.has(p.category) ? p.category : 'sonstiges',
    caption: p.caption ?? null,
    isPropertyPhoto: p.isPropertyPhoto ?? true,
  }
}
