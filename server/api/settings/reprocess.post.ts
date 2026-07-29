// Manually triggers server/tasks/reprocess.ts (WP-6: re-run rules/LLM
// extraction against archived raw_captures) from /settings — admin-only via
// the settings-auth guard. Nitro's own task-run route isn't exposed in
// production, and there was previously no way to kick off a bounded spot
// check (e.g. verifying a new provider/model config against a handful of
// auctions) without either waiting for the next cron tick or an unbounded
// country-wide run.

import type { ReprocessOptions, ReprocessResult } from '~/server/tasks/reprocess'

const MAX_LIMIT = 200

export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event).catch(() => ({}) as Record<string, unknown>)

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
  }

  const outcome = await runTask('reprocess', { payload: { ...opts } }) as { result: ReprocessResult }
  return outcome.result
})
