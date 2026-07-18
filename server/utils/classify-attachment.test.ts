import { describe, expect, it } from 'vitest'
import { classifyAttachment } from './classify-attachment'

describe('classifyAttachment', () => {
  it('classifies a Gutachten label as appraisal, not announcement', () => {
    // "Gutachten" contains "tac" as a substring, which collided with the
    // bekanntmachung rule when that rule was checked first.
    expect(classifyAttachment('Gutachten', 'Gutachten_703k59-24.pdf')).toBe('appraisal')
  })

  it('still classifies an edikt/bekanntmachung label correctly', () => {
    expect(classifyAttachment('Bekanntmachung', 'bekanntmachung.pdf')).toBe('announcement')
    expect(classifyAttachment('Edikt')).toBe('announcement')
  })

  it('classifies an exposé label correctly', () => {
    expect(classifyAttachment('Kurzbeschreibung Exposé', 'expose.pdf')).toBe('brochure')
  })

  it('classifies a photo label correctly', () => {
    expect(classifyAttachment('Foto', 'bild1.jpg')).toBe('photo')
  })

  it('falls back to other for unrecognized terms', () => {
    expect(classifyAttachment('sonstige unterlagen')).toBe('other')
  })
})

describe('classifyAttachment — mislabeled administrative PDFs', () => {
  it('does not tag a bank-details sheet labeled Foto as photo', () => {
    expect(classifyAttachment('Foto', 'Kontoverbindung-Sicherheitsleistung.pdf')).toBe('other')
  })
})
