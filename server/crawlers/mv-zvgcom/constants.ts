import type { RegionInfo } from '../types'

export const ZVGCOM_BASE = 'https://www.zvg.com'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

export const COUNTRY = 'de'
export const PLATFORM_ID = 'mv-zvgcom'

/**
 * Mecklenburg-Vorpommern, Hamburg and Schleswig-Holstein are the only German
 * states (alongside Rheinland-Pfalz, which already publishes fully via
 * zvg-portal.de) whose Amtsgerichte don't publish on the joint Bund-Länder
 * zvg-portal.de (confirmed by zvg-portal.de returning zero results for
 * land_abk=mv/hh/sh). All three instead publish via zvg.com, a privately run
 * portal that runs a JSON API (undocumented but public, no auth) under
 * /v2024/*.prg.
 */
export interface ZvgcomState extends RegionInfo {
  /** zvg.com's internal Bundesland id ("Lfd"), as returned by
   *  GET /v2024/bundesland.prg?act=getData. Static — this list of German
   *  states doesn't change. */
  bundeslandId: number
}

export const ZVGCOM_STATES: readonly ZvgcomState[] = [
  { code: 'hh', name: 'Hamburg', bundeslandId: 2 },
  { code: 'mv', name: 'Mecklenburg-Vorpommern', bundeslandId: 6 },
  { code: 'sh', name: 'Schleswig-Holstein', bundeslandId: 8 },
] as const

export const ZVGCOM_REGIONS: readonly RegionInfo[] = ZVGCOM_STATES.map(({ code, name }) => ({
  code,
  name,
}))

/** This placeholder graphic replaces the real listing photo once a Termin is
 *  aufgehoben — it is not a property photo and must not be surfaced as one. */
export const AUFGEHOBEN_PLACEHOLDER_IMG = '/bilder/aufhebung.jpg'
