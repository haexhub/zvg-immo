import { describe, expect, it } from 'vitest'
import { classifyAttachment } from './classify-attachment'

describe('classifyAttachment', () => {
  it('classifies a Gutachten label as gutachten, not bekanntmachung', () => {
    // "Gutachten" contains "tac" as a substring, which collided with the
    // bekanntmachung rule when that rule was checked first.
    expect(classifyAttachment('Gutachten', 'Gutachten_703k59-24.pdf')).toBe('gutachten')
  })

  it('still classifies an edikt/bekanntmachung label correctly', () => {
    expect(classifyAttachment('Bekanntmachung', 'bekanntmachung.pdf')).toBe('bekanntmachung')
    expect(classifyAttachment('Edikt')).toBe('bekanntmachung')
  })

  it('classifies an exposé label correctly', () => {
    expect(classifyAttachment('Kurzbeschreibung Exposé', 'expose.pdf')).toBe('exposee')
  })

  it('classifies a photo label correctly', () => {
    expect(classifyAttachment('Foto', 'bild1.jpg')).toBe('foto')
  })

  it('falls back to sonstiges for unrecognized terms', () => {
    expect(classifyAttachment('sonstige unterlagen')).toBe('sonstiges')
  })
})
