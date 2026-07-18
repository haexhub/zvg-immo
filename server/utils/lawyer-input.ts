// Shared body-parsing for the admin lawyer-catalog CRUD routes
// (server/api/settings/lawyers/*) — both create and update accept the same
// shape, so the validation lives here once instead of twice.

export interface LawyerInput {
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
}

function optionalString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed ? trimmed : null
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean)
}

/** Lowercased ISO country codes, matching Auction.country's convention
 *  (types/auction.ts) — the `@>` containment check in server/api/lawyers.get.ts
 *  and server/api/lawyer-inquiries/index.post.ts compares case-sensitively. */
function countryArray(v: unknown): string[] {
  return stringArray(v).map((x) => x.toLowerCase())
}

function nullableStringArray(v: unknown): string[] | null {
  const arr = stringArray(v)
  return arr.length ? arr : null
}

/** Parses+validates a create/update request body. Throws a 400 createError
 *  when required fields (name/email/countries) are missing or malformed. */
export function parseLawyerInput(body: Record<string, unknown>): LawyerInput {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const countries = countryArray(body.countries)
  if (!name || !email || countries.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'name, email und countries (min. 1 Land) sind erforderlich.' })
  }
  const commissionCentsRaw = body.commissionCents
  const commissionCents =
    typeof commissionCentsRaw === 'number' && Number.isFinite(commissionCentsRaw)
      ? Math.round(commissionCentsRaw)
      : null

  return {
    name,
    email,
    countries,
    firm: optionalString(body.firm),
    phone: optionalString(body.phone),
    specialization: optionalString(body.specialization),
    languages: nullableStringArray(body.languages),
    website: optionalString(body.website),
    commissionCents,
    active: body.active !== false,
  }
}
