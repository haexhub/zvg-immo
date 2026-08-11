import { getPool } from '~/server/utils/db'
import { setAutomaticCrawlingEnabled, setAutomaticLlmEnabled } from '~/server/utils/app-settings'

export default defineEventHandler(async (event) => {
  const db = getPool()
  if (!db) throw createError({ statusCode: 503, statusMessage: 'Postgres ist nicht konfiguriert.' })
  const body = await readBody<Record<string, unknown>>(event).catch(() => undefined) ?? {}
  const crawlersEnabled = body.crawlersEnabled
  const llmEnabled = body.llmEnabled
  if (typeof crawlersEnabled !== 'boolean' || typeof llmEnabled !== 'boolean') {
    throw createError({ statusCode: 400, statusMessage: 'crawlersEnabled und llmEnabled müssen boolesch sein.' })
  }
  await Promise.all([
    setAutomaticCrawlingEnabled(db, crawlersEnabled),
    setAutomaticLlmEnabled(db, llmEnabled),
  ])
  return { crawlersEnabled, llmEnabled }
})
