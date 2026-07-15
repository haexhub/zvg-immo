import { describe, expect, it } from 'vitest'
import { cellText, clean, htmlToText, parseLvDateTime, parseLvPrice } from './text'

describe('clean', () => {
  it('collapses whitespace runs to single spaces', () => {
    expect(clean(' Rīga,\n Brīvības iela 1 ')).toBe('Rīga, Brīvības iela 1')
  })

  it('returns null for empty or whitespace-only input', () => {
    expect(clean('')).toBeNull()
    expect(clean('  \n ')).toBeNull()
    expect(clean(null)).toBeNull()
    expect(clean(undefined)).toBeNull()
  })
})

describe('parseLvPrice', () => {
  it('parses "€ 22 100.00" to whole euros', () => {
    expect(parseLvPrice('€ 22 100.00')).toBe(22100)
  })

  it('rounds cent amounts', () => {
    expect(parseLvPrice('€ 1 234.56')).toBe(1235)
  })

  it('returns null for text without digits', () => {
    expect(parseLvPrice('—')).toBeNull()
  })

  it('returns null for null input', () => {
    expect(parseLvPrice(null)).toBeNull()
  })
})

describe('cellText', () => {
  it('joins a <br>-separated date and time with a space', () => {
    expect(cellText('16.07.2026<br>13:00')).toBe('16.07.2026 13:00')
    expect(cellText('16.07.2026<br/>13:00')).toBe('16.07.2026 13:00')
  })

  it('strips remaining tags', () => {
    expect(cellText('<span>16.07.2026</span>')).toBe('16.07.2026')
  })

  it('returns null for empty or null input', () => {
    expect(cellText('')).toBeNull()
    expect(cellText(null)).toBeNull()
  })
})

describe('parseLvDateTime', () => {
  it('parses "16.07.2026 13:00" into iso + German label', () => {
    expect(parseLvDateTime('16.07.2026 13:00')).toEqual({
      iso: '2026-07-16T13:00:00',
      label: '16.07.2026, 13:00 Uhr',
    })
  })

  it('parses a date without time into a label only', () => {
    expect(parseLvDateTime('16.07.2026')).toEqual({ iso: null, label: '16.07.2026' })
  })

  it('returns nulls for unparseable text', () => {
    expect(parseLvDateTime('drīzumā')).toEqual({ iso: null, label: null })
  })

  it('returns nulls for null input', () => {
    expect(parseLvDateTime(null)).toEqual({ iso: null, label: null })
  })
})

describe('htmlToText', () => {
  it('strips the double-encoded notice markup down to text with paragraph breaks', () => {
    expect(
      htmlToText('<p>Zvērināta tiesu izpildītāja pirmā izsole.</p><p>Sākumcena: € 22 100.00</p>'),
    ).toBe('Zvērināta tiesu izpildītāja pirmā izsole.\nSākumcena: € 22 100.00')
  })

  it('turns <br> into line breaks and decodes entities', () => {
    expect(htmlToText('1. rinda&nbsp;A&amp;B<br/>2. rinda &lt;x&gt;')).toBe(
      '1. rinda A&B\n2. rinda <x>',
    )
  })
})
