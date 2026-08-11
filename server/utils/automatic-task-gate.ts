import { getPool } from './db'
import { getAutomaticCrawlingEnabled, getAutomaticLlmEnabled } from './app-settings'

/**
 * Background schedules must keep working in database-less development mode,
 * so fail-open (true) applies when no database is configured at all, or
 * `getPool()` itself cannot run (e.g. outside a full Nuxt/Nitro context, as
 * in plain unit tests). Once a real Pool is available, though, a failed
 * preference read cannot be trusted — fail closed (false) instead of
 * silently running scheduled work an admin may have disabled. Manual task
 * payloads bypass this gate at the caller and are therefore never blocked by
 * these preferences.
 */
export async function isAutomaticCrawlingEnabled(): Promise<boolean> {
  let db: ReturnType<typeof getPool>
  try {
    db = getPool()
  } catch {
    return true
  }
  if (!db) return true
  return await getAutomaticCrawlingEnabled(db).catch(() => false)
}

export async function isAutomaticLlmEnabled(): Promise<boolean> {
  let db: ReturnType<typeof getPool>
  try {
    db = getPool()
  } catch {
    return true
  }
  if (!db) return true
  return await getAutomaticLlmEnabled(db).catch(() => false)
}
