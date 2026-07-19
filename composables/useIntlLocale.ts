// Maps the vue-i18n locale to the BCP-47 tag Intl.NumberFormat/DateTimeFormat
// (via toLocaleString) expect. Currency stays EUR everywhere here — user-
// currency conversion/display is WP-7, this only affects date/number formatting.
const INTL_LOCALES: Record<string, string> = { de: 'de-DE', en: 'en-US' }

export function useIntlLocale() {
  const { locale } = useI18n()
  return computed(() => INTL_LOCALES[locale.value] ?? 'en-US')
}
