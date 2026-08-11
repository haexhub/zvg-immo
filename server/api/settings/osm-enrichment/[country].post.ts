// Queues only OSM location contexts that are still missing for one country.
// The raw OSM import itself remains a host-level job and is requested through
// osm-import/[country].post.ts.
import { ensureEnabledCountriesLoaded, listRegisteredCountries } from '~/server/crawlers/registry'

export default defineEventHandler(async (event): Promise<{ started: true }> => {
  const country = (getRouterParam(event, 'country') ?? '').trim().toLowerCase()
  await ensureEnabledCountriesLoaded()
  if (!listRegisteredCountries().some((candidate) => candidate.code === country)) {
    throw createError({ statusCode: 400, statusMessage: `Unbekannte Länderquelle: ${country}` })
  }
  const body = await readBody<{ platform?: unknown, externalId?: unknown }>(event).catch(() => undefined)
  const platform = typeof body?.platform === 'string' ? body.platform.trim() || undefined : undefined
  const externalId = typeof body?.externalId === 'string' ? body.externalId.trim() || undefined : undefined
  void runTask('external-enrichment', {
    payload: { country, platform, externalId, osmOnly: true, onlyMissingLocationContext: true },
  }).catch((err: unknown) => {
    console.error('[settings/osm-enrichment] trigger failed:', (err as Error).message)
  })
  return { started: true }
})
