import type { RegionInfo } from '../types'

export const BOE_BASE = 'https://subastas.boe.es'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

export const COUNTRY = 'es'

/**
 * Spanish provincias as exposed by `subastas.boe.es` via the
 * `dato[8] = BIEN.COD_PROVINCIA` filter. Codes match the upstream form
 * options (zero-padded to 2 digits). Order is the upstream alphabetical
 * order; the registry sorts by name for display anyway.
 */
export const ES_REGIONS: readonly RegionInfo[] = [
  { code: '01', name: 'Araba/Álava' },
  { code: '02', name: 'Albacete' },
  { code: '03', name: 'Alicante/Alacant' },
  { code: '04', name: 'Almería' },
  { code: '05', name: 'Ávila' },
  { code: '06', name: 'Badajoz' },
  { code: '07', name: 'Illes Balears' },
  { code: '08', name: 'Barcelona' },
  { code: '09', name: 'Burgos' },
  { code: '10', name: 'Cáceres' },
  { code: '11', name: 'Cádiz' },
  { code: '12', name: 'Castellón/Castelló' },
  { code: '13', name: 'Ciudad Real' },
  { code: '14', name: 'Córdoba' },
  { code: '15', name: 'A Coruña' },
  { code: '16', name: 'Cuenca' },
  { code: '17', name: 'Girona' },
  { code: '18', name: 'Granada' },
  { code: '19', name: 'Guadalajara' },
  { code: '20', name: 'Gipuzkoa' },
  { code: '21', name: 'Huelva' },
  { code: '22', name: 'Huesca' },
  { code: '23', name: 'Jaén' },
  { code: '24', name: 'León' },
  { code: '25', name: 'Lleida' },
  { code: '26', name: 'La Rioja' },
  { code: '27', name: 'Lugo' },
  { code: '28', name: 'Madrid' },
  { code: '29', name: 'Málaga' },
  { code: '30', name: 'Murcia' },
  { code: '31', name: 'Navarra' },
  { code: '32', name: 'Ourense' },
  { code: '33', name: 'Asturias' },
  { code: '34', name: 'Palencia' },
  { code: '35', name: 'Las Palmas' },
  { code: '36', name: 'Pontevedra' },
  { code: '37', name: 'Salamanca' },
  { code: '38', name: 'Santa Cruz de Tenerife' },
  { code: '39', name: 'Cantabria' },
  { code: '40', name: 'Segovia' },
  { code: '41', name: 'Sevilla' },
  { code: '42', name: 'Soria' },
  { code: '43', name: 'Tarragona' },
  { code: '44', name: 'Teruel' },
  { code: '45', name: 'Toledo' },
  { code: '46', name: 'Valencia/València' },
  { code: '47', name: 'Valladolid' },
  { code: '48', name: 'Bizkaia' },
  { code: '49', name: 'Zamora' },
  { code: '50', name: 'Zaragoza' },
  { code: '51', name: 'Ceuta' },
  { code: '52', name: 'Melilla' },
] as const

export const ES_REGION_NAMES: Record<string, string> = Object.fromEntries(
  ES_REGIONS.map((r) => [r.code, r.name]),
)

/** SUBASTA.ESTADO.CODIGO values that should be treated as cancelled/closed
 *  and surfaced as `aufgehoben: true` on the Auction. The active states
 *  (PU = próx. apertura, EJ = ejecutándose) stay false. */
export const ES_ESTADO_AUFGEHOBEN = new Set(['CA', 'SU', 'FS'])
