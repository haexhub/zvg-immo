import { CONTENT_TARGET_LANGS, type ContentTargetLang } from '~/lib/content-language'

/** Parses an optional target-language filter without silently widening a bulk action. */
export function parseTargetLang(value: unknown): ContentTargetLang | undefined {
  if (value == null || value === '') return undefined
  if (typeof value === 'string' && CONTENT_TARGET_LANGS.includes(value as ContentTargetLang)) {
    return value as ContentTargetLang
  }
  throw createError({ statusCode: 400, statusMessage: 'lang muss de oder en sein.' })
}
