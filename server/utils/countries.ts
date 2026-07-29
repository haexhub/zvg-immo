// Shared ISO 3166-1 alpha-2 → German display name map. Kept dependency-free
// so both the crawler registry (region listing) and the raw archive
// (storage folder names) can import it without raw-archive.ts having to pull
// in the entire crawler graph via registry.ts.

export const COUNTRY_NAMES: Record<string, string> = {
  de: 'Deutschland',
  at: 'Österreich',
  es: 'Spanien',
  it: 'Italien',
  cz: 'Tschechien',
  pl: 'Polen',
  be: 'Belgien',
  hu: 'Ungarn',
  lt: 'Litauen',
  ba: 'Bosnien-Herzegowina',
  se: 'Schweden',
  fi: 'Finnland',
  dk: 'Dänemark',
  fr: 'Frankreich',
  is: 'Island',
  ca: 'Kanada',
  ee: 'Estland',
  lv: 'Lettland',
  pt: 'Portugal',
  si: 'Slowenien',
  gr: 'Griechenland',
  gb: 'Vereinigtes Königreich',
  us: 'USA',
  bg: 'Bulgarien',
}

/** German display name for an ISO alpha-2 code, falling back to the
 *  uppercased code itself for anything not in the map. */
export function countryDisplayName(code: string): string {
  return COUNTRY_NAMES[code.toLowerCase()] ?? code.toUpperCase()
}
