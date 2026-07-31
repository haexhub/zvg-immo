import type { ComputedRef } from 'vue'
import { isPassthroughLanguage, type ContentTargetLang } from '~/lib/content-language'

interface PlaceNameTranslationsResponse {
  translations: Record<string, string>
}

function targetContentLang(value: string): ContentTargetLang | null {
  return value === 'de' || value === 'en' ? value : null
}

/** Translates/transliterates OSM-derived place names (nearby settlements,
 *  industrial sites, airports) for display — a supplementary nicety with no
 *  dedicated pending/error UI, unlike useAuctionDetailTranslation: a failed or
 *  not-yet-translated name just falls back to its native form. */
export function usePlaceNameTranslations(options: {
  names: ComputedRef<string[]>
  country: ComputedRef<string>
}) {
  const { locale } = useI18n()
  const translations = ref<Record<string, string>>({})

  watch(
    [options.names, locale, options.country],
    async ([names, loc, country]) => {
      const lang = targetContentLang(loc)
      if (!lang || isPassthroughLanguage(country, lang)) return
      const missing = names.filter((name) => !(name in translations.value))
      if (missing.length === 0) return
      try {
        const result = await $fetch<PlaceNameTranslationsResponse>('/api/place-names/translate', {
          method: 'POST',
          body: { names: missing, lang },
        })
        translations.value = { ...translations.value, ...result.translations }
      } catch {
        // Silent fallback to native names.
      }
    },
    { immediate: true },
  )

  function displayName(name: string): string {
    return translations.value[name] ?? name
  }

  return { displayName }
}
