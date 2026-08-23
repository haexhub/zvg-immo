import { readDailyStatusSnapshots } from '~/server/utils/status-daily-snapshots'

const DEFAULT_DAYS = 14
const MAX_DAYS = 90

export default defineEventHandler(async (event) => {
  const value = Number(getQuery(event).days ?? DEFAULT_DAYS)
  const days = Number.isInteger(value) && value >= 2 && value <= MAX_DAYS ? value : DEFAULT_DAYS
  return { snapshots: await readDailyStatusSnapshots(days) }
})
