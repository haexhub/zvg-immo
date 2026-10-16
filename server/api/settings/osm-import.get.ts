// Feeds the country-status OSM card. The aggregate is shared with the daily
// history task so its historical values use exactly the live card's rules.
import { readOsmStatusByCountry, type OsmImportCountryStatus } from '~/server/utils/osm-status'

export type { OsmImportCountryStatus }

export default defineEventHandler(async (): Promise<{ countries: OsmImportCountryStatus[] }> => {
  return { countries: await readOsmStatusByCountry() }
})
