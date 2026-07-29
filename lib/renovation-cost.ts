// Sanierungskosten — reines LLM-Vokabular, gleiches Muster wie usage-idea.ts.

export const RENOVATION_COST_CATEGORIES = [
  'roof',
  'facade-insulation',
  'windows',
  'heating',
  'electrical',
  'plumbing-bathroom',
  'flooring',
  'other',
] as const

export type RenovationCostCategory = typeof RENOVATION_COST_CATEGORIES[number]

export interface RenovationCostItem {
  category: RenovationCostCategory
  label: string
  costMinEur: number
  costMaxEur: number
  rationale: string
  confidence: 'high' | 'low' | null
}
