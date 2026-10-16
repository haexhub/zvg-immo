import { getPool } from '~/server/utils/db'
import {
  MAX_LLM_CONCURRENCY,
  MAX_LLM_MAX_PER_RUN,
  getLlmConcurrency,
  getLlmMaxPerRun,
  setAutomationSettings,
} from '~/server/utils/app-settings'
import { readLlmConcurrency, readMaxLlmPerRun } from '~/server/utils/tasks/reprocess-budget'

/** undefined = leave as is, null = back to the env default, else 1..max. */
function optionalBoundedInt(value: unknown, field: string, max: number): number | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max) return value
  throw createError({ statusCode: 400, statusMessage: `${field} muss eine ganze Zahl zwischen 1 und ${max} oder null sein.` })
}

export default defineEventHandler(async (event) => {
  const db = getPool()
  if (!db) throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  const body = await readBody<Record<string, unknown>>(event).catch(() => undefined) ?? {}
  const crawlersEnabled = body.crawlersEnabled
  const llmEnabled = body.llmEnabled
  if (typeof crawlersEnabled !== 'boolean' || typeof llmEnabled !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'crawlersEnabled und llmEnabled müssen boolesch sein.' })
  }
  const llmMaxPerRun = optionalBoundedInt(body.llmMaxPerRun, 'llmMaxPerRun', MAX_LLM_MAX_PER_RUN)
  const llmConcurrency = optionalBoundedInt(body.llmConcurrency, 'llmConcurrency', MAX_LLM_CONCURRENCY)
  await setAutomationSettings(db, { crawlersEnabled, llmEnabled, llmMaxPerRun, llmConcurrency })
  return {
    crawlersEnabled,
    llmEnabled,
    llmMaxPerRun: await getLlmMaxPerRun(db),
    llmConcurrency: await getLlmConcurrency(db),
    llmMaxPerRunDefault: readMaxLlmPerRun(),
    llmConcurrencyDefault: readLlmConcurrency(),
  }
})
