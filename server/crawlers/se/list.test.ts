import { describe, expect, it } from 'vitest'
import { extractListingIds, extractNextStartAtHit, extractTotalHits } from './list'

describe('extractListingIds', () => {
  it('extracts only search result listing links and drops static navigation pages', () => {
    const html = `
      <a href="/85964.html"><span>Om cookies</span></a>
      <li class="sv-search-hit">
        <a href="/101752.html" class="h3rubrik" id="svlrid_1">Kalix</a>
        <a href="/101752.html" class="h3rubrik" id="svlrid_2"><img src="/images/1.jpg"></a>
      </li>
      <li class="sv-search-hit">
        <a class="h3rubrik featured" href="/101784.html" id="svlrid_3">Burträsk</a>
      </li>
      <a href="/37688.html"><span>Visningsinformation</span></a>
    `

    expect(extractListingIds(html)).toEqual(['101752', '101784'])
  })
})

describe('extractTotalHits', () => {
  it('reads the Swedish hit counter', () => {
    expect(extractTotalHits('<span>Visar 1-10 av totalt 46 träffar</span>')).toBe(46)
  })

  it('returns null when the counter is absent', () => {
    expect(extractTotalHits('<main>No counter</main>')).toBeNull()
  })
})

describe('extractNextStartAtHit', () => {
  it('returns the next pagination offset', () => {
    const html = '<a href="?query=*&amp;startAtHit=10">Visa nästa 10 &raquo;</a>'
    expect(extractNextStartAtHit(html, 0)).toBe(10)
  })

  it('returns null on the last page', () => {
    const html = '<span>Visar 41-46 av totalt 46 träffar</span>'
    expect(extractNextStartAtHit(html, 40)).toBeNull()
  })
})
