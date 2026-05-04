import type { BundeslandInfo } from '../types'

export const ZVG_BASE = 'https://www.zvg-portal.de'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

/**
 * The joint federal-state portal serves all 16 Bundesländer through a single
 * `land_abk` query parameter. Order matches the typical Bundesland sort.
 */
export const BUNDESLAENDER: readonly BundeslandInfo[] = [
  { abk: 'bw', name: 'Baden-Württemberg' },
  { abk: 'by', name: 'Bayern' },
  { abk: 'be', name: 'Berlin' },
  { abk: 'br', name: 'Brandenburg' },
  { abk: 'hb', name: 'Bremen' },
  { abk: 'hh', name: 'Hamburg' },
  { abk: 'he', name: 'Hessen' },
  { abk: 'mv', name: 'Mecklenburg-Vorpommern' },
  { abk: 'ni', name: 'Niedersachsen' },
  { abk: 'nw', name: 'Nordrhein-Westfalen' },
  { abk: 'rp', name: 'Rheinland-Pfalz' },
  { abk: 'sl', name: 'Saarland' },
  { abk: 'sn', name: 'Sachsen' },
  { abk: 'st', name: 'Sachsen-Anhalt' },
  { abk: 'sh', name: 'Schleswig-Holstein' },
  { abk: 'th', name: 'Thüringen' },
] as const

export const BUNDESLAND_NAMES: Record<string, string> = Object.fromEntries(
  BUNDESLAENDER.map((b) => [b.abk, b.name]),
)
