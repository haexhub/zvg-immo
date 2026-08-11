export interface VersionDetail {
  version: number
  address: string | null
  description: string | null
  propertyType: string | null
  landAreaSqm: number | null
  livingAreaSqm: number | null
  rooms: number | null
  bedrooms: number | null
  bathrooms: number | null
  floor: string | null
  heating: string | null
  units: number | null
  yearBuilt: number | null
  marketValue: number | null
  currency: string | null
  marketValueEur: number | null
  condition: unknown
  features: string[] | null
  insights: unknown
  planningNotes: unknown
  renovationNotes: string | null
  startingBid: number | null
  currentBid: number | null
  securityDeposit: number | null
  biddingNotes: string | null
  extractionSource: string | null
  extractionConfidence: string | null
  documentSummary: string | null
}

export function humanizeFieldKey(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
}

export function displayValue(value: unknown): string {
  if (value == null) return '—'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export const DIFF_FIELDS: Array<keyof VersionDetail> = [
  'address', 'description', 'propertyType', 'landAreaSqm', 'livingAreaSqm', 'rooms', 'bedrooms',
  'bathrooms', 'floor', 'heating', 'units', 'yearBuilt', 'marketValue', 'currency', 'marketValueEur',
  'condition', 'features', 'insights', 'planningNotes', 'renovationNotes', 'startingBid', 'currentBid',
  'securityDeposit', 'biddingNotes', 'extractionSource', 'extractionConfidence', 'documentSummary',
]

export function formatDate(value: string | null, locale?: string): string {
  if (!value) return '—'
  return new Date(value).toLocaleString(locale)
}

export function formatCost(value: number | null, locale?: string): string {
  if (value == null) return '—'
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(value)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}
