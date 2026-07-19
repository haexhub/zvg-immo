// Maps each crawled country (server/crawlers/registry.ts's `platforms`) to
// its primary content language (ISO 639-1) — the language `title`/
// `description` are actually written in. Used by the content-translation
// passthrough rule (server/api/auction/[platform]/[id]/translation.post.ts
// and the objekt detail page): if the viewer's target language equals the
// auction's primary language, skip the LLM call and show the original text.
export const PRIMARY_LANGUAGE: Record<string, string> = {
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
}

export type ContentTargetLang = 'de' | 'en'

/** True when the auction's country's primary language already matches
 *  `targetLang` — translating would be a no-op, so the caller should skip
 *  the LLM call and use the original title/description as-is. */
export function isPassthroughLanguage(country: string, targetLang: ContentTargetLang): boolean {
  return PRIMARY_LANGUAGE[country.toLowerCase()] === targetLang
}
