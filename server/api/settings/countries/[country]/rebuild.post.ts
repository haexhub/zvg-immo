import { rebuildCountry, type CountryRebuildResult } from '~/server/utils/country-rebuild'

export default defineEventHandler(async (event): Promise<CountryRebuildResult> => {
  const country = getRouterParam(event, 'country') ?? ''
  return await rebuildCountry(country)
})
