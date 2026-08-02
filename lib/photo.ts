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
  return {
    file: p.file,
    category: VALID_CATEGORIES.has(p.category) ? p.category : 'sonstiges',
    caption: p.caption ?? null,
    isPropertyPhoto: p.isPropertyPhoto ?? true,
  }
}

/** Orders photos so the LLM's own curation (isPropertyPhoto, then
 *  PHOTO_CATEGORIES priority — aussen/innen before grundriss/lageplan/
 *  sonstiges) decides what shows first, instead of whatever order the
 *  crawler/pdfimages pipeline happened to produce. This is the only signal
 *  that can tell a real photo of the house from an embedded Energieausweis
 *  or a picture of the meadow out front — filenames carry no such
 *  information across crawlers. Stable, so photos the LLM never classified
 *  (isPropertyPhoto defaults to true via normalizePhoto) keep their
 *  original relative order instead of being shuffled. */
export function sortCuratedPhotos(photos: readonly CuratedPhoto[]): CuratedPhoto[] {
  const rank = (p: CuratedPhoto): number =>
    (p.isPropertyPhoto ? 0 : PHOTO_CATEGORIES.length) + PHOTO_CATEGORIES.indexOf(p.category)
  return [...photos].sort((a, b) => rank(a) - rank(b))
}
