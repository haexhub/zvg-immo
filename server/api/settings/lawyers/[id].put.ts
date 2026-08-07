// Updates an existing lawyer (full-object replace of the editable fields,
// same shape as create). Admin-only via /api/settings/'s settings-auth guard.

import { getServiceClient } from '../../../utils/supabase'
import { parseLawyerInput } from '../../../utils/lawyer-input'
import { toAdminLawyer, type AdminLawyer } from './index.get'

export default defineEventHandler(async (event): Promise<AdminLawyer> => {
  const id = String(event.context.params?.id ?? '')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'id fehlt.' })
  }
  const body = await readBody<Record<string, unknown>>(event).catch(() => undefined) ?? ({} as Record<string, unknown>)
  const input = parseLawyerInput(body)

  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const { data, error } = await supabase
    .from('lawyers')
    .update({
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
    .eq('id', id)
    .select('id, name, firm, email, phone, countries, specialization, languages, website, commission_cents, active, created_at')
    .single()
  if (error || !data) {
    throw createError({ statusCode: 404, statusMessage: error?.message ?? 'Anwalt nicht gefunden.' })
  }
  return toAdminLawyer(data)
})
