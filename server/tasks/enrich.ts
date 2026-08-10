import { recordTaskRunEnd, recordTaskRunStart } from '~/server/utils/task-runs'
import { runExclusiveTask } from '~/server/utils/exclusive-task'
import { runEnrich, type EnrichOptions } from './enrich-worker'

export { runEnrich, type EnrichOptions } from './enrich-worker'

export default defineTask({
  meta: {
    name: 'enrich',
    description:
      'Crawl all regions, fetch detail pages, and download/archive documents + photos. No extraction — see the reprocess task.',
  },
  async run(event) {
    return await runExclusiveTask('enrich', async (signal) => {
      await recordTaskRunStart('enrich')
      try {
        const outcome = await runEnrich((event?.payload ?? {}) as EnrichOptions, signal)
        await recordTaskRunEnd('enrich', { result: outcome.result, warning: outcome.warning })
        return outcome
      } catch (err) {
        await recordTaskRunEnd('enrich', { error: (err as Error).message })
        throw err
      }
    })
  },
})
