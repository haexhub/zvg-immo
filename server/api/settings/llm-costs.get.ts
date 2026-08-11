// Admin cost/token overview for /settings — aggregates the llm_usage_events
// log (server/utils/llm-usage.ts) written alongside every sync and batch LLM
// call. Default 30-day window; ?days=N overrides it (1-90).

import { readLlmCostOverview } from '~/server/utils/llm-usage'

const DEFAULT_WINDOW_DAYS = 30
const MAX_WINDOW_DAYS = 90

export default defineEventHandler(async (event) => {
  const raw = Number(getQuery(event).days)
  const windowDays = Number.isFinite(raw) && raw >= 1 && raw <= MAX_WINDOW_DAYS
    ? Math.round(raw)
    : DEFAULT_WINDOW_DAYS
  return await readLlmCostOverview(windowDays)
})
