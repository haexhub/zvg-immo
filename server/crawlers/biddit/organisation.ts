import { BIDDIT_BASE, UA } from './constants'
import { pickLocalized, type LocalizedString } from './text'

interface OrganisationResponse {
  organisationId: string
  reference?: string | null
  name?: LocalizedString | null
  organisationType?: string | null
}

const FETCH_TIMEOUT_MS = 15_000

async function fetchOrgJson(orgId: string): Promise<OrganisationResponse | null> {
  const url = `${BIDDIT_BASE}/api/eco/biddit-bff/organisation/${encodeURIComponent(orgId)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${BIDDIT_BASE}/` },
    })
    if (!res.ok) return null
    return (await res.json()) as OrganisationResponse
  } finally {
    clearTimeout(timer)
  }
}

/** Fetches each unique organisation id once and returns a lookup table
 *  from id → display name. Used to resolve the placeholder
 *  `organisationReference` (numeric id) we put into `authority` during
 *  listing into the actual notary office name. */
export async function fetchOrganisationNames(
  ids: ReadonlyArray<string>,
  concurrency = 4,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))]
  const out = new Map<string, string>()
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < unique.length) {
      const idx = cursor++
      const id = unique[idx]
      if (!id) continue
      try {
        const o = await fetchOrgJson(id)
        const name = pickLocalized(o?.name)
        if (name) out.set(id, name)
      } catch {
        // Missing org names are non-fatal — the listing still falls back to
        // the numeric reference, which is itself a stable identifier.
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return out
}
