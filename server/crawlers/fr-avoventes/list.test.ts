import { describe, expect, it } from 'vitest'
import { parseDetailPage } from './list'

/** Markup mirrors the live avoventes.fr detail pages. */
const DETAIL_PAGE = `
<ul id="lightSliderDetails" class="lightGallery bg-light">
  <li><p class="rounded-top-2xl overflow-hidden selector" data-src="https://avoventes.fr/public/uploads/cabinet/158/images/a.jpg"></p></li>
  <li><p class="rounded-top-2xl overflow-hidden selector" data-src="https://avoventes.fr/public/uploads/cabinet/158/images/b.jpg"></p></li>
</ul>
<div class="my-2">
  <span class="badge badge-danger">Vente aux enchères</span>
  <span class="badge badge-secondary">Appartement</span>
</div>
<div class="row border py-4 rounded-2xl mb-4 text-black">
  <div class="col-4 text-center"><div class="d-flex flex-column align-items-center">
    <span class="font-weight-bold h4 mb-0">5</span><div class="small text-muted">pièces</div>
  </div></div>
  <div class="col-4 text-center"><div class="d-flex flex-column align-items-center">
    <span class="font-weight-bold h4 mb-0">3</span><div class="small text-muted">chambres</div>
  </div></div>
  <div class="col-4 text-center"><div class="d-flex flex-column align-items-center">
    <span class="font-weight-bold h4 mb-0">58.89</span><div class="small text-muted">m² superficie</div>
  </div></div>
</div>
<div class="font-light mb-4">Dans un ensemble immobilier sis à LE BLANC-MESNIL (93)</div>
`

describe('parseDetailPage', () => {
  const detail = parseDetailPage(DETAIL_PAGE)

  it('collects every gallery photo, not just the first', () => {
    expect(detail.photos).toEqual([
      'https://avoventes.fr/public/uploads/cabinet/158/images/a.jpg',
      'https://avoventes.fr/public/uploads/cabinet/158/images/b.jpg',
    ])
  })

  it('reads the type de bien from the secondary badge', () => {
    expect(detail.typeDeBien).toBe('Appartement')
  })

  it('reads pièces and superficie from the stat tiles (ignoring chambres)', () => {
    expect(detail.rooms).toBe(5)
    expect(detail.livingAreaSqm).toBe(58.89)
  })

  it('still extracts the free-text description', () => {
    expect(detail.beschreibung).toBe('Dans un ensemble immobilier sis à LE BLANC-MESNIL (93)')
  })

  it('returns nulls for a page without structured fields', () => {
    const empty = parseDetailPage('<html><body></body></html>')
    expect(empty).toEqual({
      beschreibung: null,
      photos: [],
      typeDeBien: null,
      rooms: null,
      livingAreaSqm: null,
      landAreaSqm: null,
    })
  })

  it('buckets the superficie of a bare-land lot into landAreaSqm', () => {
    const html = `
      <span class="badge badge-primary">Vente aux enchères</span>
      <span class="badge badge-secondary">Terrain à bâtir</span>
      <div><span class="font-weight-bold h4">512</span>
        <div class="small text-muted">m² superficie</div></div>`
    const detail = parseDetailPage(html)
    expect(detail.landAreaSqm).toBe(512)
    expect(detail.livingAreaSqm).toBeNull()
  })

  it('parses space-grouped thousands and the singular pièce label', () => {
    const html = `
      <span class="badge badge-secondary">Terrain à bâtir</span>
      <div><span class="font-weight-bold h4">1</span>
        <div class="small text-muted">pièce</div></div>
      <div><span class="font-weight-bold h4">1 200</span>
        <div class="small text-muted">m² superficie</div></div>`
    const detail = parseDetailPage(html)
    expect(detail.rooms).toBe(1)
    expect(detail.landAreaSqm).toBe(1200)
  })
})
