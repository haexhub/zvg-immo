// Maps each crawled country (server/crawlers/registry.ts's `platforms`) to the
// language its source portal normally publishes auction text in (ISO 639-1).
// This is NOT the set of UI locales the site offers. UI/content target
// languages stay intentionally limited to `ContentTargetLang` below.
export const COUNTRY_CONTENT_LANGUAGE: Record<string, string> = {
  de: 'de',
  at: 'de',
  es: 'es',
  it: 'it',
  cz: 'cs',
  pl: 'pl',
  hu: 'hu',
  lt: 'lt',
  ba: 'bs',
  se: 'sv',
  fi: 'fi',
  dk: 'da',
  fr: 'fr',
  is: 'is',
  ca: 'en',
  ee: 'et',
  lv: 'lv',
  pt: 'pt',
  si: 'sl',
  gr: 'el',
  gb: 'en',
  us: 'en',
  bg: 'bg',
}

// User-facing target languages supported by the site and translation endpoint.
// Adding a source country language above must not imply adding a selectable UI
// locale here.
export type ContentTargetLang = 'de' | 'en'

export function countryContentLanguage(country: string): string | null {
  return COUNTRY_CONTENT_LANGUAGE[country.toLowerCase()] ?? null
}

/** True when the auction's country source language already matches
 *  `targetLang` — translating would be a no-op, so the caller should skip the
 *  LLM call and use the original title/description as-is. Unknown countries
 *  deliberately do not pass through; the LLM can detect the source language. */
export function isPassthroughLanguage(country: string, targetLang: ContentTargetLang): boolean {
  return countryContentLanguage(country) === targetLang
}
