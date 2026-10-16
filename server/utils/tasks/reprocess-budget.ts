import { getLlmConcurrency, getLlmMaxPerRun } from '~/server/utils/app-settings'
import { getPool } from '~/server/utils/db'

// Claude OAuth subscriptions have a shared, finite weekly allowance. One
// bounded call per scheduled/manual run is deliberately conservative: an
// operator can raise it on /settings (or via NUXT_EXTRACT_LLM_MAX_PER_RUN)
// after measuring real usage, but an unset setting must never drain a week's
// allowance in an hourly sweep.
const DEFAULT_MAX_LLM_PER_RUN = 1
// Sequential by default; parallel candidates are opt-in because every extra
// lane is another request in flight against the same provider quota and
// another DB connection from a small pool.
const DEFAULT_LLM_CONCURRENCY = 1

function positiveInt(raw: unknown, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Env/default per-run budget (NUXT_EXTRACT_LLM_MAX_PER_RUN). */
export function readMaxLlmPerRun(): number {
  return positiveInt((useRuntimeConfig().extractLlm as { maxPerRun?: string })?.maxPerRun, DEFAULT_MAX_LLM_PER_RUN)
}

/** Env/default lane count (NUXT_EXTRACT_LLM_CONCURRENCY). */
export function readLlmConcurrency(): number {
  return positiveInt((useRuntimeConfig().extractLlm as { concurrency?: string })?.concurrency, DEFAULT_LLM_CONCURRENCY)
}

/** Per-run LLM budget: the admin-set value (/settings) wins over the env
 *  default, so it can be raised without a redeploy. */
export async function resolveMaxLlmPerRun(): Promise<number> {
  const db = getPool()
  const stored = db ? await getLlmMaxPerRun(db).catch(() => null) : null
  return stored ?? readMaxLlmPerRun()
}

/** How many candidates reprocess works on at once — same precedence. */
export async function resolveLlmConcurrency(): Promise<number> {
  const db = getPool()
  const stored = db ? await getLlmConcurrency(db).catch(() => null) : null
  return stored ?? readLlmConcurrency()
}
