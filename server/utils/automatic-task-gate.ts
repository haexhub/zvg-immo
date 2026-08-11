import { getPool } from './db'
import { getAutomaticCrawlingEnabled, getAutomaticLlmEnabled } from './app-settings'

/**
 * Background schedules must keep working in database-less development mode,
 * so an unavailable settings DB fails open. Manual task payloads bypass this
 * gate at the caller and are therefore never blocked by these preferences.
 */
export async function isAutomaticCrawlingEnabled(): Promise<boolean> {
  try {
    const db = getPool()
    return db ? await getAutomaticCrawlingEnabled(db).catch(() => true) : true
  } catch {
    return true
  }
}

export async function isAutomaticLlmEnabled(): Promise<boolean> {
  try {
    const db = getPool()
    return db ? await getAutomaticLlmEnabled(db).catch(() => true) : true
  } catch {
    return true
  }
}
