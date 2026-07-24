import { callProxySetup } from '../../../utils/claude-proxy'

export default defineEventHandler(async () => {
  return callProxySetup<{ ok: true; deleted: boolean }>('POST', '/logout')
})
