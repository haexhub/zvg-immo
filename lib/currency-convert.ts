// Pure EUR <-> display-currency conversion math, shared by
// composables/useCurrencyDisplay.ts. Kept separate from
// server/utils/exchange-rate.ts (which owns the same units-of-currency-
// per-EUR rate table but also pulls in node:fs for its disk cache) so
// importing this from client code never drags that dependency into the
// browser bundle.

/** Converts an EUR amount to `currency` using the EUR-based rate table
 *  (units of `currency` per 1 EUR). Returns the amount unchanged for EUR
 *  and null when `currency` isn't covered by `rates`. */
export function eurToCurrency(amountEur: number, currency: string, rates: Record<string, number>): number | null {
  if (currency === 'EUR') return amountEur
  const rate = rates[currency]
  return rate ? amountEur * rate : null
}

/** Inverse of eurToCurrency() — converts an amount already in `currency`
 *  back to EUR. */
export function currencyToEur(amount: number, currency: string, rates: Record<string, number>): number | null {
  if (currency === 'EUR') return amount
  const rate = rates[currency]
  return rate ? amount / rate : null
}
