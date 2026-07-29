import type { HazardKind } from '~/types/auction'

export type ExternalDataCapability =
  | 'market_trend'
  | 'market_transactions'
  | 'land_value_baseline'
  | `hazard_${HazardKind}`
  | 'location_context'
  | 'source_discovery'

export interface ExternalDataSource {
  id: string
  label: string
  countries: string[]
  capabilities: ExternalDataCapability[]
  sourceUrl: string
  licenseNote: string
  refreshCadence: string
  resolution: string
  adapter: string
}

export const EXTERNAL_DATA_SOURCES: readonly ExternalDataSource[] = [
  {
    id: 'eurostat-house-price-index',
    label: 'Eurostat House Price Index',
    countries: ['eu'],
    capabilities: ['market_trend'],
    sourceUrl: 'https://ec.europa.eu/eurostat/web/housing-price-statistics',
    licenseNote: 'Official Eurostat statistics; use as macro trend context only.',
    refreshCadence: 'quarterly',
    resolution: 'country / index series',
    adapter: 'eurostatHousePriceIndexAdapter',
  },
  {
    id: 'ecb-residential-property-prices',
    label: 'ECB Residential Property Prices',
    countries: ['eu'],
    capabilities: ['market_trend'],
    sourceUrl: 'https://data.ecb.europa.eu/data/data-categories/prices-macroeconomic-and-sectoral-statistics/other-prices-and-costs/property-prices/residential-property-prices',
    licenseNote: 'Official ECB macro statistics; not suitable for offer-level valuation.',
    refreshCadence: 'quarterly',
    resolution: 'country / index series',
    adapter: 'ecbResidentialPropertyPricesAdapter',
  },
  {
    id: 'data-europa-eu',
    label: 'data.europa.eu',
    countries: ['eu'],
    capabilities: ['source_discovery'],
    sourceUrl: 'https://data.europa.eu/en',
    licenseNote: 'EU catalogue metadata; follow each discovered dataset license.',
    refreshCadence: 'manual discovery',
    resolution: 'catalogue',
    adapter: 'dataEuropaDiscoveryAdapter',
  },
  {
    id: 'fr-dvf-geolocated',
    label: 'Demandes de valeurs foncières géolocalisées',
    countries: ['fr'],
    capabilities: ['market_transactions'],
    sourceUrl: 'https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres-geolocalisees',
    licenseNote: 'Official French transaction data; enforce anti-reidentification safeguards.',
    refreshCadence: 'semi-annual / source published files',
    resolution: 'transaction / parcel-derived location',
    adapter: 'frDvfGeolocatedAdapter',
  },
  {
    id: 'de-boris-d',
    label: 'BORIS-D Bodenrichtwerte',
    countries: ['de'],
    capabilities: ['land_value_baseline'],
    sourceUrl: 'https://www.bodenrichtwerte-boris.de/',
    licenseNote: 'Official German land-value baseline; do not label as home sale comparables.',
    refreshCadence: 'state-specific',
    resolution: 'land-value zone',
    adapter: 'deBorisDLandValueAdapter',
  },
  {
    id: 'eu-flood-risk-areas',
    label: 'EU Flood Risk Areas',
    countries: ['eu'],
    capabilities: ['hazard_flood'],
    sourceUrl: 'https://water.europa.eu/freshwater/resources/eu-flood-risk-areas-viewer',
    licenseNote: 'EU Floods Directive viewer/data; national maps may be more precise.',
    refreshCadence: 'six-year Floods Directive cycle / source updates',
    resolution: 'potential significant flood risk areas',
    adapter: 'euFloodRiskAreasAdapter',
  },
  {
    id: 'openstreetmap-overpass',
    label: 'OpenStreetMap / Overpass',
    countries: ['eu'],
    capabilities: ['location_context'],
    sourceUrl: 'https://www.openstreetmap.org/copyright',
    licenseNote: 'OSM map tags for places, transport, roads, ferries and visible neighborhood signals; completeness varies by mapper coverage.',
    refreshCadence: 'deployment-configured / source minutely updates',
    resolution: 'object tags around auction coordinates',
    adapter: 'osmLocationContextAdapter',
  },
  {
    id: 'copernicus-effis',
    label: 'Copernicus EFFIS',
    countries: ['eu'],
    capabilities: ['hazard_wildfire'],
    sourceUrl: 'https://forest-fire.emergency.copernicus.eu/applications/data-and-services',
    licenseNote: 'Copernicus fire data; distinguish static risk from short-lived forecasts.',
    refreshCadence: 'daily to seasonal depending on layer',
    resolution: 'pan-European fire danger / observations',
    adapter: 'copernicusEffisAdapter',
  },
  {
    id: 'eaws',
    label: 'European Avalanche Warning Services',
    countries: ['eu'],
    capabilities: ['hazard_avalanche', 'source_discovery'],
    sourceUrl: 'https://www.avalanches.org/',
    licenseNote: 'Terminology and national-service discovery; not parcel-level EU coverage.',
    refreshCadence: 'seasonal / national warning cadence',
    resolution: 'warning region / national service links',
    adapter: 'eawsDiscoveryAdapter',
  },
  {
    id: 'at-hora',
    label: 'HORA Austria Natural Hazard Overview',
    countries: ['at'],
    capabilities: [
      'hazard_flood',
      'hazard_avalanche',
      'hazard_earthquake',
      'hazard_landslide',
      'hazard_storm',
      'hazard_hail',
      'hazard_snow_load',
    ],
    sourceUrl: 'https://hora.gv.at/',
    licenseNote: 'Austrian national hazard overview; verify endpoint terms before bulk ingestion.',
    refreshCadence: 'source-specific',
    resolution: 'national hazard layers',
    adapter: 'atHoraHazardsAdapter',
  },
] as const

export function sourcesForCapability(capability: ExternalDataCapability): ExternalDataSource[] {
  return EXTERNAL_DATA_SOURCES.filter((source) => source.capabilities.includes(capability))
}

export function sourcesForCountry(country: string): ExternalDataSource[] {
  const normalized = country.toLowerCase()
  return EXTERNAL_DATA_SOURCES.filter(
    (source) => source.countries.includes('eu') || source.countries.includes(normalized),
  )
}
