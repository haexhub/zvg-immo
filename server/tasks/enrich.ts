import { recordTaskRunEnd, recordTaskRunStart } from '~/server/utils/task-runs'
import { isTaskActive, runExclusiveTask } from '~/server/utils/exclusive-task'
import { isAutomaticCrawlingEnabled } from '~/server/utils/automatic-task-gate'
import { runEnrich, type EnrichOptions } from './enrich-worker'

export { runEnrich, type EnrichOptions } from './enrich-worker'

/**
 * Manual triggers call this directly instead of Nitro's `runTask`, which
 * returns an already-running task for a duplicate name and silently drops the
 * new payload (same reasoning as runReprocessTask). Unlike reprocess, a newer
 * manual run queues behind the active one instead of aborting it: an aborted
 * enrich loses its crawl and the whole finalize phase (list-data persistence,
 * current-auction mirror, observations, relationships) until the next cron
 * run — far too costly for a single-auction retry or another country's click.
 * A scheduled/boot run skips while one is active or queued.
 * ponytail: queued payloads are not coalesced — repeated identical clicks run
 * back to back; dedupe would need a payload-keyed queue in runExclusiveTask.
 */
export async function runEnrichTask(options: EnrichOptions = {}): Promise<Awaited<ReturnType<typeof runEnrich>> | Record<string, never>> {
  if (options.trigger !== 'manual' && !await isAutomaticCrawlingEnabled()) {
    console.log('[enrich] automatic crawling disabled — skipping scheduled/boot run')
    return {}
  }
  if (options.trigger !== 'manual' && isTaskActive('enrich')) {
    console.log('[enrich] a run is already active — skipping scheduled/boot run')
    return {}
  }
  return await runExclusiveTask('enrich', async (signal) => {
    await recordTaskRunStart('enrich')
    try {
      const outcome = await runEnrich(options, signal)
      await recordTaskRunEnd('enrich', { result: outcome.result, warning: outcome.warning })
      return outcome
    } catch (err) {
      await recordTaskRunEnd('enrich', { error: (err as Error).message })
      throw err
    }
  }, { queue: true })
}

export default defineTask({
  meta: {
    name: 'enrich',
    description:
      'Crawl all regions, fetch detail pages, and download/archive documents + photos. No extraction — see the reprocess task.',
  },
  async run(event) {
    return await runEnrichTask((event?.payload ?? {}) as EnrichOptions)
  },
})
