// Lists the caller's own past lawyer inquiries, for the "Meine
// Anwalts-Anfragen" section on pages/account.vue.
// server/middleware/supabase-auth.ts has already verified event.context.user.

import { getServiceClient } from '../../utils/supabase'
import type { LawyerInquiry } from './index.post'

export default defineEventHandler(async (event): Promise<LawyerInquiry[]> => {
  const supabase = getServiceClient()
  if (!supabase) {
    throw createError({ statusCode: 503, statusMessage: 'Supabase ist nicht konfiguriert.' })
  }
  const { data, error } = await supabase
    .from('lawyer_inquiries')
    .select('id, lawyer_id, platform, external_id, message, commission_cents, commission_status, created_at')
    .eq('user_id', event.context.user!.id)
    .order('created_at', { ascending: false })
  if (error) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  return (data ?? []).map((row) => ({
    id: row.id as string,
    lawyerId: row.lawyer_id as string,
    platform: row.platform as string | null,
    externalId: row.external_id as string | null,
    message: row.message as string,
    commissionCents: row.commission_cents as number | null,
    commissionStatus: row.commission_status as string,
    createdAt: row.created_at as string,
  }))
})
