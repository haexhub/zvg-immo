import { getAppRuntimeStatus, getHostOperationsStatus } from '../../utils/operations-status'

export default defineEventHandler(async () => ({
  app: await getAppRuntimeStatus(),
  host: await getHostOperationsStatus(),
  now: new Date().toISOString(),
}))
