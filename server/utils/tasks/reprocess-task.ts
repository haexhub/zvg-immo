import { recordTaskRunEnd, recordTaskRunStart } from '~/server/utils/task-runs'
import { isTaskActive, runExclusiveTask } from '~/server/utils/exclusive-task'
import { isAutomaticLlmEnabled } from '~/server/utils/automatic-task-gate'
import type { ReprocessOptions, ReprocessResult } from './reprocess-input'
import { runReprocess } from './reprocess-run'
import { isPlainScheduledRun, runLockedRetrySlice } from './reprocess-locked-slice'

/**
 * Runs reprocessing with durable task status, exclusivity, and the scheduled
 * locked-auction retry slice. The task facade keeps only Nitro's public entry
 * point; orchestration stays with the other reprocess modules.
 */
export async function runReprocessTask(options: ReprocessOptions = {}): Promise<{ result: ReprocessResult } | Record<string, never>> {
  if (options.trigger !== 'manual' && !await isAutomaticLlmEnabled()) {
    console.log('[reprocess] automatic LLM processing disabled — skipping scheduled/boot run')
    return {}
  }
  if (options.trigger !== 'manual' && isTaskActive('reprocess')) {
    console.log('[reprocess] a run is already active — skipping scheduled/boot run')
    return {}
  }
  return await runExclusiveTask('reprocess', async (signal) => {
    await recordTaskRunStart('reprocess')
    try {
      // Before the long full-backlog pass: that one can run for an hour and is
      // cut short by a restart or a rate limit, which would starve the slice.
      const slice = isPlainScheduledRun(options) ? await runLockedRetrySlice(signal) : null
      const fullPass = await runReprocess(options, signal)
      const result = slice
        ? {
            ...fullPass,
            candidates: slice.candidates + fullPass.candidates,
            processed: slice.processed + fullPass.processed,
            skipped: slice.skipped + fullPass.skipped,
            llmCalls: slice.llmCalls + fullPass.llmCalls,
            llmErrors: slice.llmErrors + fullPass.llmErrors,
            rulesFalsified: slice.rulesFalsified + fullPass.rulesFalsified,
            durationMs: slice.durationMs + fullPass.durationMs,
            ...(slice.warning || fullPass.warning
              ? { warning: [slice.warning, fullPass.warning].filter(Boolean).join(' ') }
              : {}),
            ...(slice.lastLlmError || fullPass.lastLlmError
              ? { lastLlmError: fullPass.lastLlmError ?? slice.lastLlmError }
              : {}),
          }
        : fullPass
      const { warning, lastLlmError, ...summary } = result
      await recordTaskRunEnd('reprocess', { result: summary, warning, llmError: lastLlmError })
      return { result }
    } catch (err) {
      await recordTaskRunEnd('reprocess', { error: (err as Error).message })
      throw err
    }
  })
}
