import { recordTaskRunEnd, recordTaskRunStart } from '~/server/utils/task-runs'
import { runExclusiveTask } from '~/server/utils/exclusive-task'
import { isAutomaticLlmEnabled } from '~/server/utils/automatic-task-gate'
import type { ReprocessOptions } from './reprocess-input'
import { runReprocess } from './reprocess-run'

export { reprocessAuction } from './reprocess-single'
export { runReprocess } from './reprocess-run'
export type { ReprocessOptions, ReprocessResult } from './reprocess-input'

export default defineTask({
  meta: {
    name: 'reprocess',
    description:
      'Run rules/LLM extraction (incl. vision) against archived artifact_captures — no live portal fetch. Scheduled across all countries; also invokable manually/scoped.',
  },
  async run(event) {
    const options = (event?.payload ?? {}) as ReprocessOptions
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
  },
})
