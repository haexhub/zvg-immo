import { describe, expect, it } from 'vitest'
import { normalizePhoto, sortCuratedPhotos } from './photo'
import type { CuratedPhoto } from '~/types/auction'

describe('normalizePhoto', () => {
  it('turns a bare filename string into an uncategorised property photo', () => {
    expect(normalizePhoto('abcd1234.jpg')).toEqual({
      file: 'abcd1234.jpg',
      category: 'sonstiges',
      caption: null,
      isPropertyPhoto: true,
    })
  })

  it('passes a well-formed CuratedPhoto through unchanged', () => {
    const p: CuratedPhoto = { file: 'x.jpg', category: 'aussen', caption: 'Vorderansicht', isPropertyPhoto: true }
    expect(normalizePhoto(p)).toEqual(p)
  })

  it('falls back to sonstiges for an unknown category', () => {
    const p = { file: 'x.jpg', category: 'roof' as unknown, caption: null, isPropertyPhoto: false } as CuratedPhoto
    expect(normalizePhoto(p).category).toBe('sonstiges')
  })

  it('defaults a missing caption/isPropertyPhoto', () => {
    const p = { file: 'x.jpg', category: 'innen' } as unknown as CuratedPhoto
    expect(normalizePhoto(p)).toEqual({
      file: 'x.jpg',
      category: 'innen',
      caption: null,
      isPropertyPhoto: true,
    })
  })

  it('is idempotent', () => {
    const once = normalizePhoto('a.jpg')
    expect(normalizePhoto(once)).toEqual(once)
  })
})

describe('sortCuratedPhotos', () => {
  const photo = (file: string, overrides: Partial<CuratedPhoto> = {}): CuratedPhoto => ({
    file,
    category: 'sonstiges',
    caption: null,
    isPropertyPhoto: true,
    ...overrides,
  })

  it('puts real property photos before an Energieausweis/document image', () => {
    const chart = photo('chart.jpg', { category: 'sonstiges', isPropertyPhoto: false })
    const house = photo('house.jpg', { category: 'aussen', isPropertyPhoto: true })
    expect(sortCuratedPhotos([chart, house])).toEqual([house, chart])
  })

  it('orders property photos by PHOTO_CATEGORIES priority (aussen/innen before grundriss/lageplan/sonstiges)', () => {
    const misc = photo('misc.jpg', { category: 'sonstiges' })
    const site = photo('site.jpg', { category: 'lageplan' })
    const floorplan = photo('floorplan.jpg', { category: 'grundriss' })
    const interior = photo('interior.jpg', { category: 'innen' })
    const exterior = photo('exterior.jpg', { category: 'aussen' })
    expect(sortCuratedPhotos([misc, site, floorplan, interior, exterior])).toEqual([
      exterior,
      interior,
      floorplan,
      site,
      misc,
    ])
  })

  it('is a stable sort: equal-rank photos (including uncurated ones) keep their original order', () => {
    const a = photo('a.jpg')
    const b = photo('b.jpg')
    const c = photo('c.jpg')
    expect(sortCuratedPhotos([a, b, c])).toEqual([a, b, c])
  })

  it('does not mutate the input array', () => {
    const input = [photo('b.jpg', { isPropertyPhoto: false }), photo('a.jpg')]
    const copy = [...input]
    sortCuratedPhotos(input)
    expect(input).toEqual(copy)
  })
})
