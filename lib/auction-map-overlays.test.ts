import { describe, expect, it } from 'vitest'
import { featureColor, hazardRadius, hazardStatusColor, rgba } from './auction-map-overlays'

describe('auction map overlay helpers', () => {
  it('keeps the hazard status palette and distance-derived radius stable', () => {
    expect(hazardStatusColor('inside')).toBe('#dc2626')
    expect(hazardStatusColor('nearby')).toBe('#d97706')
    expect(hazardStatusColor('outside')).toBe('#16a34a')
    expect(hazardStatusColor('unknown')).toBe('#64748b')
    expect(hazardRadius({ status: 'inside' } as never)).toBe(250)
    expect(hazardRadius({ status: 'nearby', distanceMeters: 20_000 } as never)).toBe(5_000)
  })

  it('preserves feature styling and rgba conversion for overlay construction', () => {
    expect(featureColor({ kind: 'industry' } as never)).toBe('#dc2626')
    expect(featureColor({ kind: 'restaurant' } as never)).toBe('#f97316')
    expect(rgba('#ef4444', 0.12)).toBe('rgba(239,68,68,0.12)')
  })
})
