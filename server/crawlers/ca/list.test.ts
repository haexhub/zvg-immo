import { describe, expect, it } from 'vitest'
import { parsePropertyPage } from './list'

/** Markup mirrors the live /property/ pages (Divi + Toolset blocks). */
function fact(label: string, value: string): string {
  return `<div class="tb-fields-and-text" data-toolset-blocks-fields-and-text="1"><strong class="green">${label}</strong><span>${value}</span></div>`
}

const PAGE = `
<div class="more-details">
  ${fact('Municipal Address:', '0 Douglas Rd, Richmond Hill')}
  <div class="tb-fields-and-text"><p><strong class="green">Legal Description:</strong>PT LT 9 PL 163 WHITCHURCH AS IN A5859A</p></div>
  ${fact('PIN:', '03202-0269 (LT)')}
  ${fact(' Roll Number: ', '19 38 070 010 77900 0000')}
  ${fact('Property Size:', 'Area 0.07ac - Frontage 30ft - Depth 100ft')}
  ${fact('Annual Taxes: ', '<a href="/cart/?add-to-cart=1">Available in the InfoPak</a>')}
  ${fact('Assessed Value: ', '<a href="/cart/?add-to-cart=1">Available in the InfoPak</a>')}
  ${fact('Near water:', 'Yes')}
  ${fact('Vacant land:', 'Yes')}
  ${fact('Waterfront:', 'No')}
</div>
<div class="glide__slides">
  <li class="glide__slide"><img src="https://www.ontariotaxsales.ca/wp-content/uploads/YKRH24-189P-26-006.jpg"></li>
  <li class="glide__slide"><img src="https://www.ontariotaxsales.ca/wp-content/uploads/YKRH24-189N-26-006.jpg"></li>
  <li class="glide__slide"><img src="https://www.ontariotaxsales.ca/wp-content/uploads/YKRH24-189P-26-006.jpg"></li>
</div>
<p class="googlemap" style="display:none;">{43.92814504803323,-79.42003069548022}</p>
`

describe('parsePropertyPage', () => {
  const detail = parsePropertyPage(PAGE)

  it('derives title from the Yes-flagged type facts', () => {
    expect(detail.title).toBe('Vacant land')
  })

  it('converts the stated acreage to m²', () => {
    // 0.07 ac × 4046.86 m²/ac ≈ 283 m²
    expect(detail.landAreaSqm).toBe(283)
  })

  it('falls back to frontage × depth when no acreage is stated', () => {
    const d = parsePropertyPage(fact('Property Size:', 'Frontage 30ft - Depth 100ft'))
    // 3000 sq ft × 0.092903 ≈ 279 m²
    expect(d.landAreaSqm).toBe(279)
  })

  it('collects the deduplicated gallery photos', () => {
    expect(detail.photoUrls).toEqual([
      'https://www.ontariotaxsales.ca/wp-content/uploads/YKRH24-189P-26-006.jpg',
      'https://www.ontariotaxsales.ca/wp-content/uploads/YKRH24-189N-26-006.jpg',
    ])
  })

  it('falls back to the inline main image on single-photo pages', () => {
    const d = parsePropertyPage(
      '<img decoding="async" src="https://www.ontariotaxsales.ca/wp-content/uploads/YKRH24-100P-26-002.jpg" class="main-image" alt="">',
    )
    expect(d.photoUrls).toEqual([
      'https://www.ontariotaxsales.ca/wp-content/uploads/YKRH24-100P-26-002.jpg',
    ])
  })

  it('reads the hidden map coordinates', () => {
    expect(detail.lat).toBeCloseTo(43.928145, 5)
    expect(detail.lng).toBeCloseTo(-79.420031, 5)
  })

  it('keeps labelled facts but skips listing duplicates and InfoPak paywall rows', () => {
    expect(detail.facts).toEqual([
      'Property Size: Area 0.07ac - Frontage 30ft - Depth 100ft',
      'Near water: Yes',
      'Vacant land: Yes',
      'Waterfront: No',
    ])
  })

  it('returns empty defaults on a page without the fact blocks', () => {
    expect(parsePropertyPage('<html><body><p>nothing here</p></body></html>')).toEqual({
      title: null,
      landAreaSqm: null,
      photoUrls: [],
      facts: [],
      lat: null,
      lng: null,
    })
  })
})
