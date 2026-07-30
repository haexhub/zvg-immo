// User-facing target languages supported by the site and translation endpoint.
// Source languages are inferred separately from auction country codes; adding
// a country must not imply adding a selectable UI locale here.
export type ContentTargetLang = 'de' | 'en'

const REGION_DISPLAY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' })

function isKnownRegion(code: string): boolean {
  if (!/^[a-z]{2}$/i.test(code)) return false
  return REGION_DISPLAY_NAMES.of(code.toUpperCase()) !== 'Unknown Region'
}

/** Infers the language a country's official/source portals normally use from
 *  the ISO-3166 country code via CLDR likely-subtags. This keeps translation
 *  passthrough automatic as countries are enabled/disabled, while unknown or
 *  invalid country codes deliberately return null so the LLM can detect the
 *  source language itself. */
export function countryContentLanguage(country: string): string | null {
  const code = country.trim().toUpperCase()
  if (!isKnownRegion(code)) return null
  try {
    return new Intl.Locale(`und-${code}`).maximize().language || null
  } catch {
    return null
  }
}

/** True when the auction's country source language already matches
 *  `targetLang` — translating would be a no-op, so the caller should skip the
 *  LLM call and use the original title/description as-is. Unknown countries
 *  deliberately do not pass through; the LLM can detect the source language. */
export function isPassthroughLanguage(country: string, targetLang: ContentTargetLang): boolean {
  return countryContentLanguage(country) === targetLang
}
