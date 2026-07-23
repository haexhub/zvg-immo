import { describe, expect, it } from 'vitest'
import { normalizePhoto } from './photo'
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
