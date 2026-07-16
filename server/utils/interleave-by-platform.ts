import type { Auction } from '~/types/auction'

/**
 * Reorder so a single high-volume platform (e.g. agi/IT, which can have
 * thousands of never-cached listings) can't fill the whole todo list
 * front-to-back and burn through MAX_LLM_PER_RUN before smaller platforms'
 * listings are ever reached, starving them of the LLM fallback indefinitely.
 */
export function interleaveByPlatform(items: Auction[]): Auction[] {
  const byPlatform = new Map<string, Auction[]>()
  for (const a of items) {
    const list = byPlatform.get(a.platform)
    if (list) list.push(a)
    else byPlatform.set(a.platform, [a])
  }
  const groups = [...byPlatform.values()]
  const result: Auction[] = []
  for (let i = 0; result.length < items.length; i++) {
    for (const group of groups) {
      const a = group[i]
      if (a) result.push(a)
    }
  }
  return result
}
