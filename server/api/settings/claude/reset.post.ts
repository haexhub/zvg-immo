import { callProxySetup } from '../../../utils/claude-proxy'

export default defineEventHandler(async () => {
  return callProxySetup<{ ok: true }>('POST', '/reset')
})
