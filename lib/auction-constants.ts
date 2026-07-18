import type { AttachmentKind } from '~/types/auction'

export const ALL_SCOPE = 'all'
export const MULTI_PLATFORM = 'multi'
export const SCOPE_PARAM_RE = /^[a-z0-9_-]{1,64}$/i

export const ATTACHMENT_KIND_LABELS: Record<AttachmentKind, string> = {
  announcement: 'Bekanntmachung',
  photo: 'Fotos',
  brochure: 'Exposé',
  appraisal: 'Gutachten',
  other: 'Anhang',
}

export const ATTACHMENT_KIND_ORDER = [
  'announcement',
  'appraisal',
  'brochure',
  'photo',
  'other',
] as const satisfies readonly AttachmentKind[]

export function scopeParam(value: unknown, fallback = ALL_SCOPE): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : fallback
}

export function isAllScope(value: string): boolean {
  return value === ALL_SCOPE
}

export function isValidScopeParam(value: string): boolean {
  return SCOPE_PARAM_RE.test(value)
}

export function attachmentKindLabel(kind: string, fallback = 'Anhang'): string {
  return ATTACHMENT_KIND_LABELS[kind as AttachmentKind] ?? fallback
}
