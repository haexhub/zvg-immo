// Normalizes freshly extracted filenames and structured photo metadata through
// one shared server/client representation.

import type { CuratedPhoto, PhotoCategory } from '~/types/auction'

export const PHOTO_CATEGORIES: readonly PhotoCategory[] = [
  'aussen',
  'innen',
  'grundriss',
  'lageplan',
  'sonstiges',
]
const VALID_CATEGORIES = new Set<string>(PHOTO_CATEGORIES)

/** A bare string becomes an uncategorised property photo; an object with an
 *  unknown/missing category falls back to 'sonstiges'. Idempotent. */
export function normalizePhoto(p: string | CuratedPhoto): CuratedPhoto {
  if (typeof p === 'string') {
    return { file: p, category: 'sonstiges', caption: null, isPropertyPhoto: true }
  }
  const appealScore = typeof p.appealScore === 'number' && Number.isFinite(p.appealScore)
    ? Math.max(0, Math.min(100, Math.round(p.appealScore)))
    : undefined
  return {
    file: p.file,
    category: VALID_CATEGORIES.has(p.category) ? p.category : 'sonstiges',
    caption: p.caption ?? null,
    isPropertyPhoto: p.isPropertyPhoto ?? true,
    ...(appealScore === undefined ? {} : { appealScore }),
  }
}

/** Orders photos so a strong, representative property image becomes the
 * cover. The LLM first separates actual property photos from documents, then
 * ranks photos of the same kind by their visual appeal/title-image suitability.
 * The coarse category is the deterministic fallback for older images that
 * have not received an appeal score yet. */
export function sortCuratedPhotos(photos: readonly CuratedPhoto[]): CuratedPhoto[] {
  const categoryRank = (p: CuratedPhoto): number => PHOTO_CATEGORIES.indexOf(p.category)
  const propertyRank = (p: CuratedPhoto): number => p.isPropertyPhoto ? 0 : 1
  return [...photos].sort((a, b) => {
    const propertyDifference = propertyRank(a) - propertyRank(b)
    if (propertyDifference !== 0) return propertyDifference
    const appealDifference = (b.appealScore ?? -1) - (a.appealScore ?? -1)
    if (appealDifference !== 0) return appealDifference
    return categoryRank(a) - categoryRank(b)
  })
}
