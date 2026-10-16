import { captureDailyStatusSnapshot } from '~/server/utils/status-daily-snapshots'
import { runExclusiveTask } from '~/server/utils/exclusive-task'

export default defineTask({
  meta: {
    name: 'status-snapshot',
    description: 'Store one daily, per-country reading of the admin pipeline status.',
  },
  async run() {
    return await runExclusiveTask('status-snapshot', async () => {
      const rows = await captureDailyStatusSnapshot()
      console.log(`[status-snapshot] stored ${rows} status rows`)
      return { result: { rows } }
    })
  },
})
