import { captureDailyStatusSnapshot } from '~/server/utils/status-daily-snapshots'

export default defineTask({
  meta: {
    name: 'status-snapshot',
    description: 'Store one daily, per-country reading of the admin pipeline status.',
  },
  async run() {
    const rows = await captureDailyStatusSnapshot()
    console.log(`[status-snapshot] stored ${rows} status rows`)
    return { result: { rows } }
  },
})
