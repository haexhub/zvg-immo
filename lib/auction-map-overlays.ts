import type { HazardAssessment, LocationMapFeature } from '~/types/auction'

export function hazardStatusColor(status: HazardAssessment['status']): string {
  return status === 'inside' ? '#dc2626' : status === 'nearby' ? '#d97706' : status === 'outside' ? '#16a34a' : '#64748b'
}
export function hazardRadius(hazard: HazardAssessment): number {
  return hazard.status === 'inside' ? 250 : hazard.distanceMeters != null && hazard.distanceMeters > 0 ? Math.min(Math.max(hazard.distanceMeters, 250), 5_000) : 500
}
export function featureColor(feature: LocationMapFeature): string {
  if (feature.kind === 'industry') return '#dc2626'
  if (feature.kind === 'commercial') return '#ea580c'
  if (feature.kind === 'major_road') return '#9333ea'
  if (feature.kind === 'airport' || feature.kind === 'runway') return '#be123c'
  if (feature.kind === 'helipad') return '#e11d48'
  if (feature.kind === 'public_transport' || feature.kind === 'rail') return '#2563eb'
  if (feature.kind === 'ferry') return '#0891b2'
  if (feature.kind === 'school' || feature.kind === 'childcare' || feature.kind === 'university') return '#7c3aed'
  if (feature.kind === 'pharmacy' || feature.kind === 'healthcare' || feature.kind === 'hospital') return '#16a34a'
  if (feature.kind === 'groceries') return '#059669'
  if (feature.kind === 'restaurant') return '#f97316'
  if (feature.kind === 'cafe') return '#a16207'
  return feature.kind === 'recreation' ? '#65a30d' : '#64748b'
}
export const featureRadius = (feature: LocationMapFeature) => feature.kind === 'major_road' ? 8 : feature.kind === 'industry' || feature.kind === 'commercial' ? 7 : 6
export function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}
