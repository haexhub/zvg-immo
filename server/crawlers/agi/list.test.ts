import { afterEach, describe, expect, it, vi } from 'vitest'
import { DETAIL_BATCH_SIZE } from './constants'
import { buildAuctions, fetchAllDetails, type DetailEntry } from './list'

function detailEntry(idLotto: number): DetailEntry {
  return {
    idLotto,
    ruolo: '262',
    tribunale: 'Ragusa',
    tipologia: 'IMMOBILI-IMMOBILE RESIDENZIALE',
    indirizzo: 'Via Roma 1',
    comune: 'Ragusa',
    provincia: 'RG',
    prezzoBase: 100000,
    dataVendita: '2026-09-01T10:00:00',
    dataFineGara: null,
    dataUdienza: null,
    descrizione: null,
    urlPhoto: null,
    urlSchedaDettagliata: null,
    hasFoto: false,
    esito: { ID: 0, Sigla: null },
  }
}

describe('buildAuctions lat/lng', () => {
  const mapEntries = [
    {
      idLotto: 1,
      dataUltimoAggiornamento: null,
      latitudine: 41.61,
      longitudine: 14.66,
      geolocalizzato: true,
    },
    {
      idLotto: 2,
      dataUltimoAggiornamento: null,
      latitudine: 45.79,
      longitudine: 9.97,
      geolocalizzato: false,
    },
    {
      idLotto: 3,
      dataUltimoAggiornamento: null,
      latitudine: null,
      longitudine: null,
      geolocalizzato: true,
    },
  ]

  it('takes coordinates from geolocated map entries', () => {
    const [a] = buildAuctions(mapEntries, [detailEntry(1)], 'Molise', 'agi')
    expect(a?.lat).toBe(41.61)
    expect(a?.lng).toBe(14.66)
  })

  it('ignores fallback coordinates when geolocalizzato is false', () => {
    const [a] = buildAuctions(mapEntries, [detailEntry(2)], 'Molise', 'agi')
    expect(a?.lat).toBeNull()
    expect(a?.lng).toBeNull()
  })

  it('handles null coordinates and missing map entries', () => {
    const [a, b] = buildAuctions(
      mapEntries,
      [detailEntry(3), detailEntry(99)],
      'Molise',
      'agi',
    )
    expect(a?.lat).toBeNull()
    expect(b?.lat).toBeNull()
    expect(b?.lng).toBeNull()
  })
})

describe('fetchAllDetails', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('counts a rate-limited batch instead of silently dropping its lots', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([detailEntry(1)]), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    const ids = Array.from({ length: DETAIL_BATCH_SIZE + 1 }, (_, i) => i + 1)
    const result = await fetchAllDetails(ids, 'cookie')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.details.map((d) => d.idLotto)).toEqual([1])
    expect(result.failedBatches).toBe(1)
  })
})
