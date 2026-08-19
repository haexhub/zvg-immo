import { afterEach, describe, expect, it, vi } from 'vitest'
import { findOne } from './detail'
import type { OfferJson, SingleOfferResponse } from './list'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const OFFER: OfferJson = {
  id: '19454',
  type: 'real_estate_offer',
  attributes: {
    offer_id: 'DOVK.VK-147327/0009-01.2005.KH',
    title: 'Schöne Doppelhaushälften mit Garten in zentrumsnaher Lage',
    street: 'Eckenerstraße',
    house_number: '4a',
    postcode: '32756',
    city: 'Detmold',
    show_address: true,
    latitude: 51.948186,
    longitude: 8.8905277,
    buy_price: 222000,
    living_space: 120,
    plot_area: 433,
    number_of_rooms: 6,
    description_note: 'Gepflegte Doppelhaushälfte.',
    location_note: null,
    furnishing_note: null,
    other_note: null,
    updated_at: '2026-08-14T10:32:17.924Z',
  },
  relationships: {},
}

describe('findOne', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps the single-object response (same {data, included} shape as one search item)', async () => {
    const body: SingleOfferResponse = { data: OFFER, included: [] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body)))

    const a = await findOne('19454', 'bima')
    expect(a?.externalId).toBe('19454')
    expect(a?.marketValueEur).toBe(222000)
    expect(a?.address).toBe('Eckenerstraße 4a, 32756 Detmold')
  })

  it('returns null on a 404 (unknown/withdrawn id) instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })))
    const a = await findOne('does-not-exist', 'bima')
    expect(a).toBeNull()
  })

  it('throws on an unexpected error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })))
    await expect(findOne('19454', 'bima')).rejects.toThrow('HTTP 500')
  })
})
