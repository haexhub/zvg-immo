import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchListPage, parseListHtml } from './list'

/** Trimmed-down search page mirroring the live SSR markup (Juli 2026). */
const LIST_HTML = `
<div class="search-content" id="item-list-container">
  <div class="notice-cards-list notice-cards-list--xs">
    <a href="/wyszukiwarka/obwieszczenia-o-licytacji/45040/licytacja-nieruchomosci-nieruchomosc-gruntowa-zabudowana" class="notice">
      <div class="notice__content">
        <div class="notice__header">
          <div class="notice__publication-date">
            <div class="cds-text notice__publication-date-label">Data publikacji: </div>
            <div class="cds-text">16.07.2026</div>
          </div>
        </div>
        <div class="cds-text notice__title">Licytacja nieruchomości nieruchomość gruntowa zabudowana </div>
        <div class="notice__location">
          <div class="notice__province"><span class="cds-icon">map_mazowieckie</span><div class="cds-text">mazowieckie</div></div>
          <div class="notice__address"><span class="cds-icon">map_marker</span><div class="cds-text"> Łękawica Stara, 26-902 Grabów nad Pilicą</div></div>
        </div>
        <div class="notice__date"><span class="cds-icon">calendar_month</span><div class="cds-text">Początek: 10.09.2026 11:00</div></div>
      </div>
    </a>
    <a href="/wyszukiwarka/obwieszczenia-o-licytacji/45036/licytacja-nieruchomosci-lokal-mieszkalny" class="notice">
      <div class="notice__content">
        <div class="cds-text notice__title">Licytacja nieruchomości lokal mieszkalny</div>
        <div class="notice__location">
          <div class="notice__province"><span class="cds-icon">map_dolnoslaskie</span><div class="cds-text">dolnośląskie</div></div>
          <div class="notice__address"><span class="cds-icon">map_marker</span><div class="cds-text">Żołnierzy II AWP 20/13, 59-916 Bogatynia</div></div>
        </div>
        <div class="notice__date"><span class="cds-icon">calendar_month</span><div class="cds-text">Początek: 10.08.2026 13:00</div></div>
      </div>
    </a>
  </div>
  <nav class="v-pagination" role="navigation">
    <ul class="v-pagination__list">
      <li class="v-pagination__prev"><button>chevron_left</button></li>
      <li class="v-pagination__item v-pagination__item--is-active"><button>1</button></li>
      <li class="v-pagination__item"><button>2</button></li>
      <li class="v-pagination__item"><button>3</button></li>
      <li class="v-pagination__item"><button>126</button></li>
      <li class="v-pagination__next"><button>chevron_right</button></li>
    </ul>
  </nav>
</div>
`

describe('parseListHtml', () => {
  const result = parseListHtml(LIST_HTML, 'pl-komornik')

  it('parses one auction per notice card', () => {
    expect(result.auctions).toHaveLength(2)
  })

  it('maps the card fields', () => {
    const a = result.auctions[0]!
    expect(a.zvgId).toBe('45040')
    // Empty on purpose: the Sygnatura comes from enrichOne, and the snapshot
    // merge only restores it when the fresh crawl leaves the field unset.
    expect(a.aktenzeichen).toBe('')
    expect(a.objekt).toBe('Licytacja nieruchomości nieruchomość gruntowa zabudowana')
    expect(a.region).toBe('Mazowieckie')
    expect(a.adresse).toBe('Łękawica Stara, 26-902 Grabów nad Pilicą, Polen')
    expect(a.terminIso).toBe('2026-09-10')
    expect(a.terminText).toBe('10.09.2026 11:00')
    expect(a.detailUrlUpstream).toBe(
      'https://licytacje.komornik.pl/wyszukiwarka/obwieszczenia-o-licytacji/45040/licytacja-nieruchomosci-nieruchomosc-gruntowa-zabudowana',
    )
  })

  it('leaves price empty — the SSR list has none; enrichOne fills it', () => {
    expect(result.auctions[0]!.verkehrswertEur).toBeNull()
    expect(result.auctions[0]!.verkehrswertText).toBeNull()
  })

  it('reads the pagination state', () => {
    expect(result.currentPage).toBe(1)
    expect(result.lastPage).toBe(126)
    expect(result.hasNextPage).toBe(true)
  })

  it('reports no next page without pagination markup', () => {
    const single = parseListHtml('<div class="notice-cards-list"></div>', 'pl-komornik')
    expect(single.auctions).toHaveLength(0)
    expect(single.hasNextPage).toBe(false)
  })
})

describe('fetchListPage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('throws on a WAF/error page instead of silently succeeding with zero auctions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<div>Access denied</div>')))
    await expect(fetchListPage(0, 'pl-komornik')).rejects.toThrow('unexpected page')
  })
})
