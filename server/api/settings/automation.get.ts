// Persistent switches for background work only. This deliberately differs
// from llm-kill-switch: admins can pause automatic work, then still run one
// selected auction without a cron job competing for the same resources.

import { getPool } from '~/server/utils/db'
import {
  DEFAULT_AUTOMATIC_CRAWLING_ENABLED,
  DEFAULT_AUTOMATIC_LLM_ENABLED,
  getAutomaticCrawlingEnabled,
  getAutomaticLlmEnabled,
} from '~/server/utils/app-settings'

export default defineEventHandler(async () => {
  const db = getPool()
  if (!db) {
    return { crawlersEnabled: DEFAULT_AUTOMATIC_CRAWLING_ENABLED, llmEnabled: DEFAULT_AUTOMATIC_LLM_ENABLED }
  }
  const [crawlersEnabled, llmEnabled] = await Promise.all([
    getAutomaticCrawlingEnabled(db),
    getAutomaticLlmEnabled(db),
  ])
  return { crawlersEnabled, llmEnabled }
})
