import type { RegionInfo } from '../types'

export const ZVG_BASE = 'https://www.zvg-portal.de'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

export const COUNTRY = 'de'

/**
 * The joint federal-state portal serves all Bundesländer that opted into it
 * through a single `land_abk` query parameter. Order matches the typical
 * Bundesland sort. The `code` is the upstream's `land_abk` value.
 *
 * Mecklenburg-Vorpommern, Hamburg and Schleswig-Holstein are deliberately
 * absent: their Amtsgerichte never opted into this portal (land_abk=mv/hh/sh
 * are selectable but return zero results) — see server/crawlers/mv-zvgcom
 * for the portal all three actually publish on.
 */
export const DE_REGIONS: readonly RegionInfo[] = [
  { code: 'bw', name: 'Baden-Württemberg' },
  { code: 'by', name: 'Bayern' },
  { code: 'be', name: 'Berlin' },
  { code: 'br', name: 'Brandenburg' },
  { code: 'hb', name: 'Bremen' },
  { code: 'he', name: 'Hessen' },
  { code: 'ni', name: 'Niedersachsen' },
  { code: 'nw', name: 'Nordrhein-Westfalen' },
  { code: 'rp', name: 'Rheinland-Pfalz' },
  { code: 'sl', name: 'Saarland' },
  { code: 'sn', name: 'Sachsen' },
  { code: 'st', name: 'Sachsen-Anhalt' },
  { code: 'th', name: 'Thüringen' },
] as const

export const DE_REGION_NAMES: Record<string, string> = Object.fromEntries(
  DE_REGIONS.map((r) => [r.code, r.name]),
)
