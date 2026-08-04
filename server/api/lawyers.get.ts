// Public lawyer catalog for a given country, used by components/LawyerContact.vue
// on the auction detail page. No auth needed — browsing the catalog is public,
// only sending an inquiry (server/api/lawyer-inquiries/index.post.ts) requires
// a login. Returns only public-safe fields: `email` (the relay target for
// commission-bearing inquiries) is never sent to the client — see
// server/db/schema/lawyers.ts's comment on the `lawyers` table.

import { getServiceClient } from '../utils/supabase'

export interface PublicLawyer {
  id: string
  name: string
  firm: string | null
  specialization: string | null
  languages: string[] | null
  website: string | null
}

export default defineEventHandler(async (event): Promise<PublicLawyer[]> => {
  const query = getQuery(event)
  const country = typeof query.country === 'string' ? query.country.trim().toLowerCase() : ''
  if (!country) {
    throw createError({ statusCode: 400, statusMessage: 'country fehlt.' })
  }

  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  // `.contains()` renders as `countries @> ARRAY[country]`, hitting
  // idx_lawyers_countries (GIN).
  const { data, error } = await supabase
    .from('lawyers')
    .select('id, name, firm, specialization, languages, website')
    .eq('active', true)
    .contains('countries', [country])
    .order('name', { ascending: true })
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    firm: (row.firm as string | null) ?? null,
    specialization: (row.specialization as string | null) ?? null,
    languages: (row.languages as string[] | null) ?? null,
    website: (row.website as string | null) ?? null,
  }))
})
