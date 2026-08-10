import { readTranslationStatusByCountry, type TranslationStatusCounts } from '~/server/utils/translation-status'

export default defineEventHandler(async (): Promise<Record<string, TranslationStatusCounts>> => {
  return readTranslationStatusByCountry()
})
