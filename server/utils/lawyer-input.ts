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

const MAX_COMMISSION_CENTS = 2_147_483_647

function optionalString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed ? trimmed : null
}

/** The website is rendered publicly as an href (components/LawyerContact.vue),
 *  so only absolute http(s) URLs are stored — never `javascript:` or `data:`. */
function websiteUrl(v: unknown): string | null {
  const raw = optionalString(v)
  if (!raw) return null
  const protocol = URL.canParse(raw) ? new URL(raw).protocol : ''
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw createError({ statusCode: 400, statusMessage: 'website muss eine http(s)-URL sein.' })
  }
  return raw
}

// One plain address: the value becomes the outbox mail's `to`, where a comma
// or whitespace would turn it into several recipients.
const SINGLE_EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/

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
 *  when required fields (name/email/countries) are missing or malformed, or
 *  when the website is not an http(s) URL. */
export function parseLawyerInput(body: Record<string, unknown>): LawyerInput {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const countries = countryArray(body.countries)
  if (!name || !email || countries.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'name, email und countries (min. 1 Land) sind erforderlich.' })
  }
  if (!SINGLE_EMAIL_RE.test(email)) {
    throw createError({ statusCode: 400, statusMessage: 'email muss eine einzelne gültige Adresse sein.' })
  }
  const commissionCentsRaw = body.commissionCents
  const commissionCents =
    typeof commissionCentsRaw === 'number' && Number.isFinite(commissionCentsRaw)
      ? Math.round(commissionCentsRaw)
      : null
  // commission_cents is a Postgres integer; reject here instead of letting an
  // out-of-range value surface as a raw database error.
  if (commissionCents !== null && (commissionCents < 0 || commissionCents > MAX_COMMISSION_CENTS)) {
    throw createError({ statusCode: 400, statusMessage: 'commissionCents muss zwischen 0 und 2147483647 liegen.' })
  }

  return {
    name,
    email,
    countries,
    firm: optionalString(body.firm),
    phone: optionalString(body.phone),
    specialization: optionalString(body.specialization),
    languages: nullableStringArray(body.languages),
    website: websiteUrl(body.website),
    commissionCents,
    active: body.active !== false,
  }
}
