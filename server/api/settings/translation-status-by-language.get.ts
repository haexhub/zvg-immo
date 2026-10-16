import { readTranslationStatusByCountryAndLanguage, type TranslationStatusByLanguage } from '~/server/utils/translation-status'

export default defineEventHandler(async (): Promise<Record<string, TranslationStatusByLanguage>> => {
  return readTranslationStatusByCountryAndLanguage()
})
