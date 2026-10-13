// Saves the current filter set under a user-chosen name. `filters` arrives as
// the query-param object (route.query) and is stored in the contract's own
// serialization (lib/auction-search-filter-contract.ts), so unknown keys,
// nested objects and non-string values never reach the jsonb column.

import { getServiceClient } from '../../utils/supabase'
import { publicError } from '../../utils/public-error'
import type { SavedSearch } from './index.get'
import {
  hasExplicitHideRulesOnly,
  parseAuctionSearchFilters,
  serializeAuctionSearchFilters,
  unsupportedAlertFilterKeys,
} from '~/lib/auction-search-filter-contract'

const MAX_NAME_LENGTH = 200
// Roughly a long search URL; the row is re-read on every alert batch.
const MAX_FILTERS_JSON_LENGTH = 4_000

export default defineEventHandler(async (event): Promise<SavedSearch> => {
  const body = await readBody<{ name?: unknown; filters?: unknown }>(event).catch(
    () => undefined,
  ) ?? ({} as { name?: unknown; filters?: unknown })
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'Name fehlt.' })
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw createError({ statusCode: 400, statusMessage: `Name ist länger als ${MAX_NAME_LENGTH} Zeichen.` })
  }
  const query = body.filters && typeof body.filters === 'object' ? body.filters as Record<string, unknown> : {}
  const parsed = parseAuctionSearchFilters(query)
  const filters = serializeAuctionSearchFilters(parsed)
  // Serializing against default false drops an explicit llmOnly=0, which only
  // means something against an admin hideRulesOnly default; keep the override
  // so hydrating the saved search later does not flip back to that default.
  if (hasExplicitHideRulesOnly(query)) filters.llmOnly = parsed.hideRulesOnly ? '1' : '0'
  if (JSON.stringify(filters).length > MAX_FILTERS_JSON_LENGTH) {
    throw createError({ statusCode: 400, statusMessage: 'Filter sind zu umfangreich.' })
  }
  const unsupported = unsupportedAlertFilterKeys(parsed)
  if (unsupported.length) {
    throw createError({
      statusCode: 400,
      statusMessage: `Diese Filter können für Benachrichtigungen noch nicht ausgewertet werden: ${unsupported.join(', ')}.`,
    })
  }

  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const { data, error } = await supabase
    .from('saved_searches')
    .insert({ user_id: event.context.user!.id, name, filters })
    .select('id, name, filters, created_at')
    .single()
  if (error || !data) {
    throw publicError('POST /api/saved-searches', 500, 'Speichern fehlgeschlagen.', error)
  }
  return {
    id: data.id as string,
    name: data.name as string,
    filters: data.filters as Record<string, string>,
    createdAt: data.created_at as string,
  }
})
