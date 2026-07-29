// Nutzungsideen — reines LLM-Vokabular (kein regelbasierter Klassifizierer
// wie bei property-type.ts), gleiches Muster wie condition.ts.

export const USAGE_IDEA_TYPES = [
  'owner-occupation',
  'owner-occupation-with-sublet',
  'vacation-rental',
  'farm',
  'agricultural',
  'forestry',
  'warehouse',
  'other',
] as const

export type UsageIdeaType = typeof USAGE_IDEA_TYPES[number]

export interface UsageIdea {
  type: UsageIdeaType
  label: string
  rationale: string
  confidence: 'high' | 'low' | null
}
