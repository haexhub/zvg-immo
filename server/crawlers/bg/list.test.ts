import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAllListings, mapAnnouncement, type BgAnnouncement } from './list'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubAnnouncements(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body)))
}

function makeAnnouncement(overrides: Partial<BgAnnouncement> = {}): BgAnnouncement {
  return {
    id: 3505,
    code: '20267130400057',
    caseNumber: '20267130400057',
    title: 'ПОЗЕМЛЕН ИМОТ С ИДЕНТИФИКАТОР № 10135.3515.768.3.49',
    description:
      '<p>Апартамент, находящ се в гр. Варна, кв. &bdquo;Св. Иван Рилски&ldquo; № 53, разположен на трети етаж.</p>',
    propertyType: 'имот',
    startPrice: 136000,
    gpkTax: 13600,
    auctionStartDate: '2026-09-17T06:00:00Z',
    cancelled: false,
    createdByFirstName: 'Люба',
    createdByLastName: 'Тодорова',
    ...overrides,
  }
}

describe('mapAnnouncement', () => {
  it('maps the core identity and pricing fields', () => {
    const a = mapAnnouncement(makeAnnouncement(), 'bg-zapori')
    expect(a.platform).toBe('bg-zapori')
    expect(a.country).toBe('bg')
    expect(a.externalId).toBe('3505')
    expect(a.caseNumber).toBe('20267130400057')
    expect(a.marketValueEur).toBe(136000)
    expect(a.startingBid).toBe(136000)
    expect(a.sourceSecurityDeposit).toBe(13600)
  })

  it('builds the officer name as authority', () => {
    const a = mapAnnouncement(makeAnnouncement(), 'bg-zapori')
    expect(a.authority).toBe('Люба Тодорова')
  })

  it('falls back to code when caseNumber is missing', () => {
    const a = mapAnnouncement(makeAnnouncement({ caseNumber: null, code: '01' }), 'bg-zapori')
    expect(a.caseNumber).toBe('01')
  })

  it('converts the genuine UTC auctionStartDate straight through, with a Sofia-local label', () => {
    const a = mapAnnouncement(makeAnnouncement(), 'bg-zapori')
    expect(a.auctionDateIso).toBe('2026-09-17T06:00:00Z')
    expect(a.auctionDateText).toBe('17.09.2026, 09:00 Uhr')
  })

  it('strips the HTML description and extracts the kvartal address', () => {
    const a = mapAnnouncement(makeAnnouncement(), 'bg-zapori')
    expect(a.description).toBe(
      'Апартамент, находящ се в гр. Варна, кв. "Св. Иван Рилски" № 53, разположен на трети етаж.',
    )
    expect(a.address).toBe('кв. Св. Иван Рилски № 53, гр. Варна, Bulgarien')
  })

  it('extracts long-form village/locality addresses from zapori descriptions', () => {
    const a = mapAnnouncement(
      makeAnnouncement({
        id: 3453,
        description:
          '<p>1/2 идеална част от имот, находящ се в село Приселци, община Аврен, област Варна, местност &bdquo;Пазарлията&quot; &ndash; част ІІ.</p>',
      }),
      'bg-zapori',
    )
    expect(a.address).toBe('местност Пазарлията, село Приселци, община Аврен, област Варна, Bulgarien')
  })

  it('leaves address null when neither title nor description name a settlement', () => {
    const a = mapAnnouncement(
      makeAnnouncement({ title: 'ПИ 61128.14.37', description: 'УПИ № III-14001 с идентификатор 61128.14.37' }),
      'bg-zapori',
    )
    expect(a.address).toBeNull()
  })

  it('rejects a zero/negative startPrice and gpkTax', () => {
    const a = mapAnnouncement(makeAnnouncement({ startPrice: 0, gpkTax: null }), 'bg-zapori')
    expect(a.marketValueEur).toBeNull()
    expect(a.startingBid).toBeNull()
    expect(a.sourceSecurityDeposit).toBeNull()
  })

  it('points detailUrl at the public #/announcements/display/:id route', () => {
    const a = mapAnnouncement(makeAnnouncement(), 'bg-zapori')
    expect(a.detailUrl).toBe('https://zapori.mjs.bg/#/announcements/display/3505')
    expect(a.detailUrlUpstream).toBe('https://zapori.mjs.bg/#/announcements/display/3505')
  })
})

describe('fetchAllListings', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drops announcements whose auction date has already passed', async () => {
    stubAnnouncements([
      makeAnnouncement({ id: 1, auctionStartDate: '2024-04-02T08:00:00Z' }),
      makeAnnouncement({ id: 2, auctionStartDate: '2099-01-01T08:00:00Z' }),
      makeAnnouncement({ id: 3, auctionStartDate: null }),
    ])
    const { auctions } = await fetchAllListings('bg-zapori')
    expect(auctions.map((a) => a.externalId)).toEqual(['2', '3'])
  })
})
