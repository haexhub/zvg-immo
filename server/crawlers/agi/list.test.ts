import { describe, expect, it } from 'vitest'
import { buildAuctions, type DetailEntry } from './list'

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
