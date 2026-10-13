// Manually triggers server/tasks/reprocess.ts (WP-6: re-run rules/LLM
// extraction against archived artifact_captures) from /settings — admin-only via
// the settings-auth guard. Nitro's own task-run route isn't exposed in
// production, and there was previously no way to kick off a bounded spot
// check (e.g. verifying a new provider/model config against a handful of
// auctions) without either waiting for the next cron tick or an unbounded
// country-wide run.
//
// Detached, not awaited: up to MAX_LIMIT forced extractions (incl. vision
// calls) can outlast the reverse proxy's request timeout, and a client retry
// after a perceived 504 would let runExclusiveTask abort the almost-finished
// first run (see geo-metrics.post.ts). The run's summary, warning and LLM
// error land in reprocessStatus (server/utils/task-runs.ts), which the
// settings card polls via /api/settings/llm-batch-jobs.

import { runReprocessTask, type ReprocessOptions } from '~/server/tasks/reprocess'

const MAX_LIMIT = 200

export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event).catch(() => undefined) ?? ({} as Record<string, unknown>)

  if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > MAX_LIMIT) {
    throw createError({ statusCode: 400, statusMessage: `limit: ganze Zahl zwischen 1 und ${MAX_LIMIT} erforderlich.` })
  }

  const opts: ReprocessOptions = {
    limit: body.limit,
    force: body.force !== false,
    country: typeof body.country === 'string' ? body.country : undefined,
    platform: typeof body.platform === 'string' ? body.platform : undefined,
    externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
    caseNumber: typeof body.caseNumber === 'string' ? body.caseNumber : undefined,
    batch: typeof body.batch === 'boolean' ? body.batch : undefined,
    trigger: 'manual',
  }

  // The rejection is already recorded as reprocessStatus.lastError by
  // runReprocessTask; the catch only keeps the trigger from becoming an
  // unhandled rejection.
  void runReprocessTask(opts).catch((err: unknown) => {
    console.error('[settings/reprocess] trigger failed:', (err as Error).message)
  })
  return { started: true as const }
})
