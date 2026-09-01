import { recordTaskRunEnd, recordTaskRunStart } from '~/server/utils/task-runs'
import { runExclusiveTask } from '~/server/utils/exclusive-task'
import { isAutomaticLlmEnabled } from '~/server/utils/automatic-task-gate'
import type { ReprocessOptions, ReprocessResult } from './reprocess-input'
import { runReprocess } from './reprocess-run'

export { reprocessAuction } from './reprocess-single'
export { runReprocess } from './reprocess-run'
export type { ReprocessOptions, ReprocessResult } from './reprocess-input'

/**
 * Runs extraction with the task's durable status bookkeeping and in-process
 * exclusivity. Manual HTTP triggers call this directly instead of Nitro's
 * `runTask`: Nitro returns the already-running task for a duplicate task name
 * and silently discards the new payload. That made a retry request a no-op
 * whenever the scheduled reprocess was still active. runExclusiveTask keeps
 * the intended latest-run-wins behavior while preserving the new options.
 */
export async function runReprocessTask(options: ReprocessOptions = {}): Promise<{ result: ReprocessResult } | Record<string, never>> {
  if (options.trigger !== 'manual' && !await isAutomaticLlmEnabled()) {
    console.log('[reprocess] automatic LLM processing disabled — skipping scheduled/boot run')
    return {}
  }
  return await runExclusiveTask('reprocess', async (signal) => {
    await recordTaskRunStart('reprocess')
    try {
      const result = await runReprocess(options, signal)
      const { warning, lastLlmError, ...summary } = result
      await recordTaskRunEnd('reprocess', { result: summary, warning, llmError: lastLlmError })
      return { result }
    } catch (err) {
      await recordTaskRunEnd('reprocess', { error: (err as Error).message })
      throw err
    }
  })
}

export default defineTask({
  meta: {
    name: 'reprocess',
    description:
      'Run rules/LLM extraction (incl. vision) against archived artifact_captures — no live portal fetch. Scheduled across all countries; also invokable manually/scoped.',
  },
  async run(event) {
    const options = (event?.payload ?? {}) as ReprocessOptions
    return await runReprocessTask(options)
  },
})
