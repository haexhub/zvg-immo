export interface LocalizedString {
  fr?: string | null
  nl?: string | null
  de?: string | null
  en?: string | null
}

/** Picks the first non-empty value from a multilingual object. Biddit's
 *  payload populates only the locales actually used by the notary; Flemish
 *  studies fill `nl`, Walloon ones fill `fr`. Order chosen so German users
 *  get the form they're most likely to encounter — Brussels/Walloon notaries
 *  outnumber Flemish ones on Biddit by roughly 2:1. */
export function pickLocalized(s: LocalizedString | null | undefined): string | null {
  if (!s) return null
  return s.fr || s.nl || s.de || s.en || null
}

export interface AddressLike {
  street?: LocalizedString | null
  estateNumber?: string | null
  estateBoxNumber?: string | null
  postalCode?: string | null
  municipality?: LocalizedString | null
}

/** Composes "Street Number, PostalCode Municipality" — the same shape the
 *  geocoder consumes for BOE/zvbawü/AT entries. Drops empty segments to
 *  avoid stray commas. */
export function formatAddress(a: AddressLike | null | undefined): string | null {
  if (!a) return null
  const street = pickLocalized(a.street)
  const num = [a.estateNumber, a.estateBoxNumber ? `bus ${a.estateBoxNumber}` : null]
    .filter(Boolean)
    .join(' ')
  const streetLine = [street, num].filter(Boolean).join(' ').trim()
  const muniLine = [a.postalCode, pickLocalized(a.municipality)].filter(Boolean).join(' ').trim()
  const parts = [streetLine, muniLine].filter((s) => s.length > 0)
  return parts.length > 0 ? parts.join(', ') : null
}
