import type { LocationDemographicContext, NearbyPlace } from '~/types/auction'

export function useAuctionDetailFormatters() {
  const { t } = useI18n()
  const intlLocale = useIntlLocale()
  const { currency, eurToDisplay, nativeToDisplay } = useCurrencyDisplay()

  function formatPrice(marketValueEur: number | null): string {
    const converted = eurToDisplay(marketValueEur)
    if (converted == null) return '–'
    return converted.toLocaleString(intlLocale.value, { style: 'currency', currency: currency.value, maximumFractionDigits: 0 })
  }

  function formatNative(amount: number | null | undefined, sourceCurrency: string | null | undefined): string | null {
    const converted = nativeToDisplay(amount ?? null, sourceCurrency)
    if (converted == null) return null
    return converted.toLocaleString(intlLocale.value, { style: 'currency', currency: currency.value, maximumFractionDigits: 0 })
  }

  function formatDate(iso: string | null, fallback: string | null): string {
    if (!iso) return fallback ?? '–'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return fallback ?? iso
    return d.toLocaleString(intlLocale.value, {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  function formatArea(n: number | null): string {
    if (n == null) return '–'
    return `${n.toLocaleString(intlLocale.value, { maximumFractionDigits: 0 })} m²`
  }

  function formatCount(n: number | null | undefined): string {
    if (n == null) return '–'
    return n.toLocaleString(intlLocale.value, { maximumFractionDigits: 1 })
  }

  function formatPricePerSqm(n: number | null): string {
    if (n == null) return '–'
    const converted = eurToDisplay(n)
    if (converted == null) return '–'
    const maximumFractionDigits = Math.abs(converted) < 1 ? 2 : 0
    return `${converted.toLocaleString(intlLocale.value, { style: 'currency', currency: currency.value, maximumFractionDigits })}/m²`
  }

  function formatPercent(n: number | null): string {
    if (n == null) return '–'
    return `${n > 0 ? '+' : ''}${n.toLocaleString(intlLocale.value, { maximumFractionDigits: 0 })}%`
  }

  function formatShortDate(iso: string | null | undefined): string {
    if (!iso) return '–'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString(intlLocale.value, { day: '2-digit', month: 'short', year: 'numeric' })
  }

  function formatDistance(meters: number | null | undefined): string {
    if (meters == null) return '–'
    if (meters < 1000) {
      return t('objektDetail.distanceMeters', {
        meters: meters.toLocaleString(intlLocale.value, { maximumFractionDigits: 0 }),
      })
    }
    return t('objektDetail.distanceKilometers', {
      kilometers: (meters / 1000).toLocaleString(intlLocale.value, { maximumFractionDigits: 1 }),
    })
  }

  function formatConcentration(value: number): string {
    return `${value.toLocaleString(intlLocale.value, { maximumFractionDigits: 1 })} µg/m³`
  }

  function formatPopulation(place: NearbyPlace): string | null {
    if (place.population == null) return null
    return t('objektDetail.population', {
      count: place.population.toLocaleString(intlLocale.value, { maximumFractionDigits: 0 }),
    })
  }

  function formatLandValue(eurPerSqm: number): string {
    return formatPricePerSqm(eurPerSqm)
  }

  function demographicSignalLabel(level: LocationDemographicContext['youthSignal']): string {
    return t(`objektDetail.demographicSignalLevel.${level}`)
  }

  function icsFilename(caseNumber: string): string {
    return `${(caseNumber || 'termin').replace(/[/\\]/g, '-')}.ics`
  }

  return {
    currency,
    eurToDisplay,
    formatPrice,
    formatNative,
    formatDate,
    formatArea,
    formatCount,
    formatPricePerSqm,
    formatPercent,
    formatShortDate,
    formatDistance,
    formatConcentration,
    formatPopulation,
    formatLandValue,
    demographicSignalLabel,
    icsFilename,
  }
}
