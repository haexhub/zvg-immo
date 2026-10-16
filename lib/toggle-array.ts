/** Adds `value` if absent, removes it if present — used for the country/region
 *  multi-select checkboxes shared by useAuctionSearchState and the landing
 *  page's own (route-decoupled) local filter state. */
export function toggleInArray<T>(array: T[], value: T): T[] {
  const set = new Set(array)
  if (set.has(value)) set.delete(value)
  else set.add(value)
  return [...set]
}
