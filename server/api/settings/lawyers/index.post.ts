// Creates a new lawyer in the catalog. Admin-only via /api/settings/'s
// settings-auth guard.

import { getServiceClient } from '../../../utils/supabase'
import { parseLawyerInput } from '../../../utils/lawyer-input'
import { toAdminLawyer, type AdminLawyer } from './index.get'

export default defineEventHandler(async (event): Promise<AdminLawyer> => {
  const body = await readBody<Record<string, unknown>>(event).catch(() => ({}))
  const input = parseLawyerInput(body)

  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const { data, error } = await supabase
    .from('lawyers')
    .insert({
      name: input.name,
      firm: input.firm,
      email: input.email,
      phone: input.phone,
      countries: input.countries,
      specialization: input.specialization,
      languages: input.languages,
      website: input.website,
      commission_cents: input.commissionCents,
      active: input.active,
    })
    .select('id, name, firm, email, phone, countries, specialization, languages, website, commission_cents, active, created_at')
    .single()
  if (error || !data) {
    throw createError({ statusCode: 500, statusMessage: error?.message ?? 'Anlegen fehlgeschlagen.' })
  }
  return toAdminLawyer(data)
})
