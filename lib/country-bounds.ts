export type CountryBounds = [[number, number], [number, number]]

export const COUNTRY_BOUNDS: Partial<Record<string, CountryBounds>> = {
  at: [[46.35, 8.75], [49.05, 17.2]],
  ba: [[42.55, 15.7], [45.3, 19.65]],
  be: [[49.45, 2.5], [51.55, 6.4]],
  ca: [[41.65, -141.0], [83.15, -52.6]],
  cz: [[48.55, 12.05], [51.1, 18.9]],
  de: [[47.25, 5.85], [55.1, 15.05]],
  dk: [[54.55, 8.0], [57.85, 15.25]],
  ee: [[57.5, 21.75], [59.75, 28.25]],
  es: [[27.6, -18.4], [43.9, 4.4]],
  fi: [[59.6, 19.0], [70.1, 31.6]],
  fr: [[41.3, -5.2], [51.1, 9.6]],
  gb: [[49.85, -8.65], [60.9, 1.8]],
  gr: [[34.7, 19.2], [41.75, 29.7]],
  hu: [[45.7, 16.1], [48.6, 22.9]],
  is: [[63.25, -24.6], [66.6, -13.4]],
  it: [[35.45, 6.6], [47.1, 18.6]],
  lt: [[53.85, 20.9], [56.45, 26.85]],
  lv: [[55.65, 20.95], [58.1, 28.25]],
  pl: [[49.0, 14.1], [54.85, 24.15]],
  pt: [[36.95, -9.55], [42.15, -6.15]],
  se: [[55.25, 10.95], [69.1, 24.2]],
  si: [[45.4, 13.35], [46.9, 16.65]],
  us: [[24.4, -125.0], [49.4, -66.9]],
}

export function boundsForCountries(countryCodes: readonly string[]): CountryBounds | null {
  const bounds = countryCodes
    .map((code) => COUNTRY_BOUNDS[code.toLowerCase()])
    .filter((bounds): bounds is CountryBounds => bounds != null)

  if (bounds.length === 0) return null

  const south = Math.min(...bounds.map((b) => b[0][0]))
  const west = Math.min(...bounds.map((b) => b[0][1]))
  const north = Math.max(...bounds.map((b) => b[1][0]))
  const east = Math.max(...bounds.map((b) => b[1][1]))
  return [[south, west], [north, east]]
}
