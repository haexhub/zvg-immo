// Persistent switches for background work only. This deliberately differs
// from llm-kill-switch: admins can pause automatic work, then still run one
// selected auction without a cron job competing for the same resources.

import { getPool } from '~/server/utils/db'
import {
  DEFAULT_AUTOMATIC_CRAWLING_ENABLED,
  DEFAULT_AUTOMATIC_LLM_ENABLED,
  getAutomaticCrawlingEnabled,
  getAutomaticLlmEnabled,
  getLlmConcurrency,
  getLlmMaxPerRun,
} from '~/server/utils/app-settings'
import { readLlmConcurrency, readMaxLlmPerRun } from '~/server/utils/tasks/reprocess-budget'

export default defineEventHandler(async () => {
  // `llmMaxPerRun` / `llmConcurrency` are the admin-set values (null = none
  // stored); the `*Default` fields are what applies then (env or built-in).
  const defaults = { llmMaxPerRunDefault: readMaxLlmPerRun(), llmConcurrencyDefault: readLlmConcurrency() }
  const db = getPool()
  if (!db) {
    return {
      crawlersEnabled: DEFAULT_AUTOMATIC_CRAWLING_ENABLED,
      llmEnabled: DEFAULT_AUTOMATIC_LLM_ENABLED,
      llmMaxPerRun: null,
      llmConcurrency: null,
      ...defaults,
    }
  }
  const [crawlersEnabled, llmEnabled, llmMaxPerRun, llmConcurrency] = await Promise.all([
    getAutomaticCrawlingEnabled(db),
    getAutomaticLlmEnabled(db),
    getLlmMaxPerRun(db),
    getLlmConcurrency(db),
  ])
  return { crawlersEnabled, llmEnabled, llmMaxPerRun, llmConcurrency, ...defaults }
})
