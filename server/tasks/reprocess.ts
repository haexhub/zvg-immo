import type { ReprocessOptions, ReprocessResult } from '../utils/tasks/reprocess-input'
import { runReprocess } from '../utils/tasks/reprocess-run'
export { runReprocessTask } from '../utils/tasks/reprocess-task'

export { reprocessAuction } from '../utils/tasks/reprocess-single'
export { runReprocess } from '../utils/tasks/reprocess-run'
export type { ReprocessOptions, ReprocessResult } from '../utils/tasks/reprocess-input'

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
