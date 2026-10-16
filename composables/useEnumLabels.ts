// Resolves the code-neutral enum ids from lib/property-type.ts and
// lib/auction-constants.ts (post terminology-rename) to a label in the
// current UI locale — mapped per locale, not machine-translated, same as a
// country-code → display-name lookup. Falls back to the id itself (or a
// caller-supplied fallback) for an id with no translation yet.
import type { AttachmentKind } from '~/types/auction'

export function usePropertyTypeLabel() {
  const { t, te } = useI18n()
  return (id: string, fallback?: string): string => {
    const key = `propertyType.${id}`
    return te(key) ? t(key) : (fallback ?? id)
  }
}

export function useAttachmentKindLabel() {
  const { t, te } = useI18n()
  return (kind: string, fallback?: string): string => {
    const key = `attachmentKind.${kind as AttachmentKind}`
    if (te(key)) return t(key)
    return fallback || t('attachmentKind.other')
  }
}

export function useCountryLabel() {
  const { t, te } = useI18n()
  return (code: string, fallback?: string): string => {
    const key = `country.${code}`
    return te(key) ? t(key) : (fallback ?? code.toUpperCase())
  }
}

export function useConditionLabel() {
  const { t, te } = useI18n()
  return (id: string, fallback?: string): string => {
    const key = `condition.${id}`
    return te(key) ? t(key) : (fallback ?? id)
  }
}

export function useFeatureLabel() {
  const { t, te } = useI18n()
  return (id: string, fallback?: string): string => {
    const key = `feature.${id}`
    return te(key) ? t(key) : (fallback ?? id)
  }
}

