import { describe, expect, it } from 'vitest'
import { extractInertiaPage, parseSqm } from './text'

describe('parseSqm', () => {
  it('parses plain integers', () => {
    expect(parseSqm('63 m²')).toBe(63)
    expect(parseSqm('448 m²')).toBe(448)
  })

  it('parses dot-decimal values (the facts format)', () => {
    expect(parseSqm('179.95 m²')).toBe(179.95)
  })

  it('parses German thousands-dot values', () => {
    expect(parseSqm('1.438 m²')).toBe(1438)
    expect(parseSqm('17.219 m²')).toBe(17219)
  })

  it('parses German decimal-comma values', () => {
    expect(parseSqm('320,00 m²')).toBe(320)
    expect(parseSqm('1.234,56 m²')).toBe(1234.56)
  })

  it('returns null for missing or non-numeric values', () => {
    expect(parseSqm(null)).toBeNull()
    expect(parseSqm(undefined)).toBeNull()
    expect(parseSqm('siehe Gutachten')).toBeNull()
  })
})

describe('extractInertiaPage', () => {
  it('parses a normal data-page payload', () => {
    const html =
      '<div id="app" data-page="{&quot;props&quot;:{&quot;auction&quot;:{&quot;title&quot;:&quot;Foo&quot;}}}"></div>'
    expect(extractInertiaPage(html)).toEqual({ props: { auction: { title: 'Foo' } } })
  })

  it('strips a literal \\u0000 JSON escape that zvbawü emits mid-word (confirmed live on real titles)', () => {
    const html =
      '<div id="app" data-page="{&quot;props&quot;:{&quot;auction&quot;:{&quot;title&quot;:&quot;Gr\\u0000ünflä\\u0000che&quot;}}}"></div>'
    expect(extractInertiaPage(html)).toEqual({ props: { auction: { title: 'Grünfläche' } } })
  })

  it('returns null for HTML without a data-page attribute', () => {
    expect(extractInertiaPage('<div></div>')).toBeNull()
  })
})
