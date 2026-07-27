import {
  deleteRawArchiveCountry,
  type DeleteRawArchiveCountryResult,
} from '~/server/utils/raw-archive-delete'

export default defineEventHandler(async (event): Promise<DeleteRawArchiveCountryResult> => {
  const country = getRouterParam(event, 'country') ?? ''
  return await deleteRawArchiveCountry(country)
})
