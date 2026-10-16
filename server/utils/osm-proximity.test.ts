import { describe, expect, it } from 'vitest'
import { proximityConditionAnyOf } from './osm-proximity'

// WP-0 moved lat/lng from the versioned auction_details ("d") onto the
// identity table auctions ("a"); these queries must reference a.lat/a.lng,
// not d.lat/d.lng — the latter no longer exists and 500s the whole request.
describe('osm-proximity', () => {
  const add = (value: unknown) => `$${JSON.stringify(value)}`

  it('proximityConditionAnyOf references a.lat/a.lng, not d.lat/d.lng', () => {
    const sql = proximityConditionAnyOf('place', ['city', 'town'], 5000, add)
    expect(sql).toContain('a.lat')
    expect(sql).toContain('a.lng')
    expect(sql).not.toContain('d.lat')
    expect(sql).not.toContain('d.lng')
  })
})
