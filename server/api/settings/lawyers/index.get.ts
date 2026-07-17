// Admin listing of the lawyer catalog for the /settings "Anwälte" section.
// Lives under /api/settings/ and therefore automatically inherits
// server/middleware/settings-auth.ts's guard — no separate auth check here.
// Unlike server/api/lawyers.get.ts (public, no email), this returns every
// column: the admin needs the email to know who they're managing.

import { getServiceClient } from '../../../utils/supabase'

export interface AdminLawyer {
  id: string
  name: string
  firm: string | null
  email: string
  phone: string | null
  countries: string[]
  specialization: string | null
  languages: string[] | null
  website: string | null
  commissionCents: number | null
  active: boolean
  createdAt: string
}

export default defineEventHandler(async (): Promise<AdminLawyer[]> => {
  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const { data, error } = await supabase
    .from('lawyers')
    .select('id, name, firm, email, phone, countries, specialization, languages, website, commission_cents, active, created_at')
    .order('name', { ascending: true })
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  return (data ?? []).map(toAdminLawyer)
})

export function toAdminLawyer(row: Record<string, unknown>): AdminLawyer {
  return {
    id: row.id as string,
    name: row.name as string,
    firm: (row.firm as string | null) ?? null,
    email: row.email as string,
    phone: (row.phone as string | null) ?? null,
    countries: (row.countries as string[] | null) ?? [],
    specialization: (row.specialization as string | null) ?? null,
    languages: (row.languages as string[] | null) ?? null,
    website: (row.website as string | null) ?? null,
    commissionCents: (row.commission_cents as number | null) ?? null,
    active: row.active as boolean,
    createdAt: row.created_at as string,
  }
}
