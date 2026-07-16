import { describe, expect, it } from 'vitest'
import type { Auction } from '~/types/auction'
import { interleaveByPlatform } from './interleave-by-platform'

function auction(platform: string, id: string): Auction {
  return { platform, zvgId: id } as Auction
}

describe('interleaveByPlatform', () => {
  it('gives every platform a turn before a large one exhausts its backlog', () => {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => auction('agi', `it${i}`)),
      ...Array.from({ length: 3 }, (_, i) => auction('boe', `es${i}`)),
      ...Array.from({ length: 2 }, (_, i) => auction('lv', `lv${i}`)),
    ]

    const result = interleaveByPlatform(items)

    expect(result).toHaveLength(items.length)
    // Every platform must appear within the first N slots, where N is the
    // number of distinct platforms — the whole point of the round robin.
    const firstThreePlatforms = result.slice(0, 3).map((a) => a.platform).sort()
    expect(firstThreePlatforms).toEqual(['agi', 'boe', 'lv'])
  })

  it('preserves within-platform order', () => {
    const items = [auction('agi', 'a'), auction('agi', 'b'), auction('agi', 'c')]
    expect(interleaveByPlatform(items).map((a) => a.zvgId)).toEqual(['a', 'b', 'c'])
  })

  it('handles an empty list', () => {
    expect(interleaveByPlatform([])).toEqual([])
  })
})
