/**
 * Resolves the market value of one auction that may contain several parts.
 * A source-provided total is authoritative; otherwise every supplied part
 * belongs to the same auction and is added together.
 */
export function aggregateMarketValue(
  parts: readonly (number | null | undefined)[],
  explicitTotal: number | null | undefined = null,
): number | null {
  if (isPositiveFinite(explicitTotal)) return explicitTotal

  const sum = parts
    .filter(isPositiveFinite)
    .reduce((total, value) => total + value, 0)
  return isPositiveFinite(sum) ? sum : null
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0
}
