import type { RegionInfo } from '../types'

export const AGI_BASE = 'https://www.astegiudiziarie.it'
export const AGI_API_BASE = 'https://webapi.astegiudiziarie.it/api'
export const COUNTRY = 'it'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'

/** Batch size for the search/Data API call. */
export const DETAIL_BATCH_SIZE = 50

/** idGenere=1 means Immobili (real estate) on the portal. */
export const ID_GENERE_IMMOBILI = 1

export const IT_REGIONS: readonly RegionInfo[] = [
  { code: 'abruzzo', name: 'Abruzzo' },
  { code: 'basilicata', name: 'Basilicata' },
  { code: 'calabria', name: 'Calabria' },
  { code: 'campania', name: 'Campania' },
  { code: 'emilia-romagna', name: 'Emilia-Romagna' },
  { code: 'friuli-venezia-giulia', name: 'Friuli-Venezia Giulia' },
  { code: 'lazio', name: 'Lazio' },
  { code: 'liguria', name: 'Liguria' },
  { code: 'lombardia', name: 'Lombardia' },
  { code: 'marche', name: 'Marche' },
  { code: 'molise', name: 'Molise' },
  { code: 'piemonte', name: 'Piemonte' },
  { code: 'puglia', name: 'Puglia' },
  { code: 'sardegna', name: 'Sardegna' },
  { code: 'sicilia', name: 'Sicilia' },
  { code: 'toscana', name: 'Toscana' },
  { code: 'trentino-alto-adige', name: 'Trentino-Alto Adige' },
  { code: 'umbria', name: 'Umbria' },
  { code: 'valle-daosta', name: "Valle d'Aosta" },
  { code: 'veneto', name: 'Veneto' },
] as const

/** Maps the canonical region code to the Italian region name used by the portal API. */
export const PORTAL_REGION_NAMES: Record<string, string> = {
  abruzzo: 'Abruzzo',
  basilicata: 'Basilicata',
  calabria: 'Calabria',
  campania: 'Campania',
  'emilia-romagna': 'Emilia-Romagna',
  'friuli-venezia-giulia': 'Friuli-Venezia Giulia',
  lazio: 'Lazio',
  liguria: 'Liguria',
  lombardia: 'Lombardia',
  marche: 'Marche',
  molise: 'Molise',
  piemonte: 'Piemonte',
  puglia: 'Puglia',
  sardegna: 'Sardegna',
  sicilia: 'Sicilia',
  toscana: 'Toscana',
  'trentino-alto-adige': 'Trentino-Alto Adige',
  umbria: 'Umbria',
  'valle-daosta': "Valle d'Aosta",
  veneto: 'Veneto',
}

export const IT_REGION_NAMES: Record<string, string> = Object.fromEntries(
  IT_REGIONS.map((r) => [r.code, r.name]),
)
