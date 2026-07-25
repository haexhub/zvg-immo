import {
  isCountryEnabled,
  listRegisteredCountries,
} from '~/server/crawlers/registry'

export interface CountrySourceSetting {
  code: string
  name: string
  enabled: boolean
  platforms: Array<{ id: string; name: string }>
}

export interface CountrySourceSettings {
  countries: CountrySourceSetting[]
}

export function countrySourceSettings(): CountrySourceSettings {
  return {
    countries: listRegisteredCountries().map((country) => ({
      code: country.code,
      name: country.name,
      enabled: isCountryEnabled(country.code),
      platforms: [
        ...new Map(
          country.regions
            .flatMap((region) => region.platforms)
            .map((platform) => [platform.id, platform]),
        ).values(),
      ],
    })),
  }
}
