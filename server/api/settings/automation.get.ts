// Persistent switches for background work only. This deliberately differs
// from llm-kill-switch: admins can pause automatic work, then still run one
// selected auction without a cron job competing for the same resources.

import { getPool } from '~/server/utils/db'
import {
  DEFAULT_AUTOMATIC_CRAWLING_ENABLED,
  DEFAULT_AUTOMATIC_LLM_ENABLED,
  getAutomaticCrawlingEnabled,
  getAutomaticLlmEnabled,
  getLlmMaxPerRun,
} from '~/server/utils/app-settings'
import { readMaxLlmPerRun } from '~/server/utils/tasks/reprocess-input'

export default defineEventHandler(async () => {
  // `llmMaxPerRun` is the admin-set cap (null = none stored); `llmMaxPerRunDefault`
  // is what applies then (NUXT_EXTRACT_LLM_MAX_PER_RUN or the built-in default).
  const llmMaxPerRunDefault = readMaxLlmPerRun()
  const db = getPool()
  if (!db) {
    return { crawlersEnabled: DEFAULT_AUTOMATIC_CRAWLING_ENABLED, llmEnabled: DEFAULT_AUTOMATIC_LLM_ENABLED, llmMaxPerRun: null, llmMaxPerRunDefault }
  }
  const [crawlersEnabled, llmEnabled, llmMaxPerRun] = await Promise.all([
    getAutomaticCrawlingEnabled(db),
    getAutomaticLlmEnabled(db),
    getLlmMaxPerRun(db),
  ])
  return { crawlersEnabled, llmEnabled, llmMaxPerRun, llmMaxPerRunDefault }
})
