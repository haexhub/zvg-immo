import { getPool } from '~/server/utils/db'
import { MAX_LLM_MAX_PER_RUN, getLlmMaxPerRun, setAutomationSettings } from '~/server/utils/app-settings'
import { readMaxLlmPerRun } from '~/server/utils/tasks/reprocess-input'

export default defineEventHandler(async (event) => {
  const db = getPool()
  if (!db) throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  const body = await readBody<Record<string, unknown>>(event).catch(() => undefined) ?? {}
  const crawlersEnabled = body.crawlersEnabled
  const llmEnabled = body.llmEnabled
  if (typeof crawlersEnabled !== 'boolean' || typeof llmEnabled !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'crawlersEnabled und llmEnabled müssen boolesch sein.' })
  }
  // undefined = leave as is, null = back to the env default.
  const llmMaxPerRun = body.llmMaxPerRun
  if (llmMaxPerRun !== undefined && llmMaxPerRun !== null
    && !(typeof llmMaxPerRun === 'number' && Number.isInteger(llmMaxPerRun) && llmMaxPerRun >= 1 && llmMaxPerRun <= MAX_LLM_MAX_PER_RUN)) {
    throw createError({ statusCode: 400, statusMessage: `llmMaxPerRun muss eine ganze Zahl zwischen 1 und ${MAX_LLM_MAX_PER_RUN} oder null sein.` })
  }
  await setAutomationSettings(db, { crawlersEnabled, llmEnabled, llmMaxPerRun })
  return { crawlersEnabled, llmEnabled, llmMaxPerRun: await getLlmMaxPerRun(db), llmMaxPerRunDefault: readMaxLlmPerRun() }
})
