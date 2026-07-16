import type { RegionInfo } from '../types'

export const ZVGCOM_BASE = 'https://www.zvg.com'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

export const COUNTRY = 'de'
export const PLATFORM_ID = 'mv-zvgcom'

/**
 * Mecklenburg-Vorpommern's Amtsgerichte are the only ones alongside
 * Rheinland-Pfalz that don't publish on the joint Bund-Länder zvg-portal.de
 * (confirmed both by zvg-portal.de returning zero results for land_abk=mv and
 * by MV Amtsgericht pages — e.g. ag-greifswald.mv-justiz.de — pointing at
 * zvg.com as their Zwangsversteigerung listing). zvg.com is a privately run
 * portal the MV courts contract with to publish termine; it runs a JSON API
 * (undocumented but public, no auth) under /v2024/*.prg.
 */
export const MV_REGIONS: readonly RegionInfo[] = [
  { code: 'mv', name: 'Mecklenburg-Vorpommern' },
] as const

/** zvg.com's internal Bundesland id ("Lfd") for Mecklenburg-Vorpommern, as
 *  returned by GET /v2024/bundesland.prg?act=getData. Static — this list of
 *  German states doesn't change. */
export const MV_BUNDESLAND_ID = 6

/** This placeholder graphic replaces the real listing photo once a Termin is
 *  aufgehoben — it is not a property photo and must not be surfaced as one. */
export const AUFGEHOBEN_PLACEHOLDER_IMG = '/bilder/aufhebung.jpg'
