// Converts marketValueEur -> the user's preferred currency, entirely in the
// browser. `server: false` means the rate table (/api/exchange-rates) is
// never fetched during SSR, so `rates` holds the `default()` empty object on
// both the server render and the client's pre-mount render — identical
// output regardless of the currency cookie, no hydration mismatch. Once the
// client-only fetch resolves, `activeCurrency`/converted amounts update
// reactively. This is what keeps the SSR-rendered page currency-invariant
// (only locale varies server-side — see i18n design doc Baustein C,
// "Cache-Explosion Sprache × Währung").
import { currencyToEur, eurToCurrency } from '~/lib/currency-convert'

export function useCurrencyDisplay() {
  const { currency, setPreferredCurrency } = useCurrencyPreference()
  const { data: rates } = useFetch<Record<string, number>>('/api/exchange-rates', {
    default: () => ({}) as Record<string, number>,
    server: false,
  })

  // Falls back to EUR whenever the preferred code isn't (yet) backed by a
  // rate — covers the pre-fetch window above and an unrecognized code.
  const activeCurrency = computed(() => (
    currency.value === 'EUR' || rates.value[currency.value] ? currency.value : 'EUR'
  ))

  function eurToDisplay(amountEur: number | null): number | null {
    if (amountEur == null) return null
    return eurToCurrency(amountEur, activeCurrency.value, rates.value) ?? amountEur
  }

  /** Inverse of eurToDisplay — converts a user-entered amount (in the active
   *  display currency) to EUR, for filtering against marketValueEur. */
  function displayToEur(amount: number | null): number | null {
    if (amount == null) return null
    return currencyToEur(amount, activeCurrency.value, rates.value) ?? amount
  }

  /** Converts an amount already in its own native `sourceCurrency` (e.g.
   *  Auction.startingBid/currentBid/sourceSecurityDeposit, which — unlike
   *  marketValue — have no server-computed EUR counterpart) to the active
   *  display currency, via EUR as the pivot. Falls back to the un-rebased
   *  amount if either conversion leg can't find a rate. */
  function nativeToDisplay(amount: number | null, sourceCurrency: string | null | undefined): number | null {
    if (amount == null) return null
    const eur = currencyToEur(amount, sourceCurrency ?? 'EUR', rates.value)
    if (eur == null) return amount
    return eurToCurrency(eur, activeCurrency.value, rates.value) ?? eur
  }

  const availableCurrencies = computed(() => ['EUR', ...Object.keys(rates.value).sort()])

  return { currency: activeCurrency, setPreferredCurrency, eurToDisplay, displayToEur, nativeToDisplay, availableCurrencies }
}
