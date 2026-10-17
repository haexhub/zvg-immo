import { startMemorySampler } from '../utils/memory-diagnostics'

export default defineNitroPlugin(() => {
  startMemorySampler()
})
