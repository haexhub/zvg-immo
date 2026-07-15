import { describe, expect, it } from 'vitest'
import { clean, parseEeDateTime, parseEePrice, stripAnnouncementHtml } from './text'

describe('clean', () => {
  it('collapses whitespace runs to single spaces', () => {
    expect(clean('  Harju maakond,\n  Tallinn ')).toBe('Harju maakond, Tallinn')
  })

  it('returns null for empty or whitespace-only input', () => {
    expect(clean('')).toBeNull()
    expect(clean('   \n ')).toBeNull()
    expect(clean(null)).toBeNull()
    expect(clean(undefined)).toBeNull()
  })
})

describe('parseEeDateTime', () => {
  it('parses "14.07.2026 kl 10:00" into iso + German label', () => {
    expect(parseEeDateTime('14.07.2026 kl 10:00')).toEqual({
      iso: '2026-07-14T10:00:00',
      label: '14.07.2026, 10:00 Uhr',
    })
  })

  it('returns nulls for text without the kl-pattern', () => {
    expect(parseEeDateTime('oksjon on peatatud')).toEqual({ iso: null, label: null })
  })

  it('returns nulls for null input', () => {
    expect(parseEeDateTime(null)).toEqual({ iso: null, label: null })
  })
})

describe('parseEePrice', () => {
  it('parses space-grouped whole-euro amounts', () => {
    expect(parseEePrice('1 700 €')).toBe(1700)
    expect(parseEePrice('65 610 €')).toBe(65610)
  })

  it('returns null for text without digits', () => {
    expect(parseEePrice('kokkuleppel')).toBeNull()
  })

  it('returns null for null input', () => {
    expect(parseEePrice(null)).toBeNull()
  })
})

describe('stripAnnouncementHtml', () => {
  it('strips tags and keeps paragraph breaks', () => {
    expect(
      stripAnnouncementHtml(
        '<p style="text-align: justify;">Kohtutäitur müüb <strong>korteriomandi</strong>.</p><p>Alghind 1 700 €.</p>',
      ),
    ).toBe('Kohtutäitur müüb korteriomandi.\nAlghind 1 700 €.')
  })

  it('turns <br> into line breaks and decodes entities', () => {
    expect(stripAnnouncementHtml('Tuba&nbsp;2<br/>K&amp;M &lt;kaasas&gt;')).toBe(
      'Tuba 2\nK&M <kaasas>',
    )
  })

  it('collapses runs of blank lines to one blank line', () => {
    expect(stripAnnouncementHtml('<p>A</p><p></p><p></p><p>B</p>')).toBe('A\n\nB')
  })
})
