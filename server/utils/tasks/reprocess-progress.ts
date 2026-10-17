import { type TaskRunSummary } from '~/server/utils/task-runs'
import type { Candidate } from './reprocess-input'

export type ReprocessCounter = 'processed' | 'skipped' | 'llmCalls' | 'llmErrors'

/**
 * Run counters for one reprocess run: the aggregate and the per-country
 * breakdown /settings shows. `bump` updates both at once, since candidates are
 * handled in parallel lanes and a per-iteration diff of the aggregate would
 * attribute other lanes' work to the wrong country.
 *
 * The per-country map is seeded at 0/N so every country in scope shows up
 * right away instead of appearing one by one as the run reaches it — and so a
 * run that stops early (rate limit) still reports the countries it never got to.
 */
export function createReprocessProgress(candidates: readonly Candidate[]) {
  const candidatesTotalByCountry = new Map<string, number>()
  for (const c of candidates) candidatesTotalByCountry.set(c.country, (candidatesTotalByCountry.get(c.country) ?? 0) + 1)
  const progressByCountry = new Map<string, TaskRunSummary>(
    [...candidatesTotalByCountry].map(([country, candidatesTotal]) => [
      country,
      { candidatesTotal, processed: 0, skipped: 0, llmCalls: 0, llmErrors: 0 },
    ]),
  )
  const totals: Record<ReprocessCounter, number> = { processed: 0, skipped: 0, llmCalls: 0, llmErrors: 0 }
  function bump(country: string, counter: ReprocessCounter): void {
    totals[counter]++
    const prev = progressByCountry.get(country)
    if (prev) progressByCountry.set(country, { ...prev, [counter]: (prev[counter] ?? 0) + 1 })
  }
  return { totals, bump, progressByCountry }
}
