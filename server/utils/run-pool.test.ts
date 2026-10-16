import { describe, expect, it } from 'vitest'
import { runPool } from './run-pool'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

describe('runPool', () => {
  it('handles every item exactly once, in order of pickup', async () => {
    const seen: number[] = []
    await runPool([1, 2, 3, 4, 5], 2, async (n) => { await tick(); seen.push(n) })
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('never runs more than `concurrency` workers at once, and does use them', async () => {
    let active = 0
    let peak = 0
    await runPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      active++
      peak = Math.max(peak, active)
      await tick()
      active--
    })
    expect(peak).toBe(3)
  })

  it('is a plain sequential loop at concurrency 1', async () => {
    let active = 0
    let peak = 0
    const order: number[] = []
    await runPool([1, 2, 3], 1, async (n) => { active++; peak = Math.max(peak, active); await tick(); order.push(n); active-- })
    expect(peak).toBe(1)
    expect(order).toEqual([1, 2, 3])
  })

  it('stops handing out items once shouldStop is true, letting in-flight ones finish', async () => {
    let stop = false
    const done: number[] = []
    await runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      if (n === 2) stop = true
      await tick()
      done.push(n)
    }, () => stop)
    expect(done.sort()).toEqual([1, 2])
  })

  it('rethrows the first error after in-flight work settled, without starting more', async () => {
    const done: number[] = []
    await expect(runPool([1, 2, 3, 4, 5], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      await tick()
      done.push(n)
    })).rejects.toThrow('boom')
    expect(done).toEqual([1])
  })

  it('copes with fewer items than lanes and with none', async () => {
    await expect(runPool([1], 8, async () => {})).resolves.toBeUndefined()
    await expect(runPool([], 4, async () => { throw new Error('unused') })).resolves.toBeUndefined()
  })
})
