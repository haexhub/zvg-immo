import { listBundeslaender, type BundeslandEntry } from '../crawlers/registry'

export default defineEventHandler((): BundeslandEntry[] => {
  return listBundeslaender()
})
