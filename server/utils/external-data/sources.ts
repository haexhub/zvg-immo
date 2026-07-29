import type { HazardKind } from '~/types/auction'

export type ExternalDataCapability =
  | 'market_trend'
  | 'market_transactions'
  | 'land_value_baseline'
  | `hazard_${HazardKind}`
  | 'location_context'
  | 'demographics'
  | 'poi_places'
  | 'transport_network'
  | 'settlement_structure'
  | 'noise_airport'
  | 'flight_routes'
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
    capabilities: ['location_context', 'poi_places', 'transport_network'],
    sourceUrl: 'https://www.openstreetmap.org/copyright',
    licenseNote: 'Europe-wide open map tags for POIs, transport, roads, landuse and visible neighborhood signals; completeness varies by mapper coverage.',
    refreshCadence: 'deployment-configured / source minutely updates',
    resolution: 'object tags around auction coordinates',
    adapter: 'osmLocationContextAdapter',
  },
  {
    id: 'overture-maps',
    label: 'Overture Maps',
    countries: ['eu'],
    capabilities: ['poi_places', 'transport_network', 'settlement_structure'],
    sourceUrl: 'https://docs.overturemaps.org/',
    licenseNote: 'Global open GeoParquet datasets for places, buildings, divisions and transportation; useful as a bulk alternative/complement to live Overpass.',
    refreshCadence: 'monthly / release cadence',
    resolution: 'feature-level places, roads, buildings and administrative divisions',
    adapter: 'overtureMapsAdapter',
  },
  {
    id: 'eurostat-gisco-population-grid',
    label: 'Eurostat GISCO Population Grid',
    countries: ['eu'],
    capabilities: ['demographics', 'settlement_structure'],
    sourceUrl: 'https://ec.europa.eu/eurostat/web/gisco/geodata/population-distribution/population-grids',
    licenseNote: 'Official gridded population baseline for comparable density and settlement analysis across Europe.',
    refreshCadence: 'census / release cadence',
    resolution: '1 km population grid',
    adapter: 'eurostatGiscoPopulationGridAdapter',
  },
  {
    id: 'eurostat-degree-urbanisation',
    label: 'Eurostat Degree of Urbanisation',
    countries: ['eu'],
    capabilities: ['demographics', 'settlement_structure'],
    sourceUrl: 'https://ec.europa.eu/eurostat/web/gisco/geodata/population-distribution/degree-urbanisation',
    licenseNote: 'Official LAU-level urban/rural classification for comparable city/town/rural context.',
    refreshCadence: 'source release cadence',
    resolution: 'LAU / population-grid-derived urbanisation class',
    adapter: 'eurostatDegreeUrbanisationAdapter',
  },
  {
    id: 'eurostat-regional-demographics',
    label: 'Eurostat Regional Demographics',
    countries: ['eu'],
    capabilities: ['demographics'],
    sourceUrl: 'https://ec.europa.eu/eurostat/cache/metadata/en/demo_r_gind3_esms.htm',
    licenseNote: 'Official NUTS 2/3 population change, births/deaths and demographic balance; good for ageing/outmigration signals above parcel level.',
    refreshCadence: 'annual',
    resolution: 'NUTS 2/3',
    adapter: 'eurostatRegionalDemographicsAdapter',
  },
  {
    id: 'eurostat-regional-labour-market',
    label: 'Eurostat Regional Labour Market',
    countries: ['eu'],
    capabilities: ['demographics'],
    sourceUrl: 'https://ec.europa.eu/eurostat/cache/metadata/en/reg_lmk_esms.htm',
    licenseNote: 'Official EU-LFS regional labour market indicators, generally down to NUTS 2; use as regional employment context, not micro-location proof.',
    refreshCadence: 'quarterly / annual',
    resolution: 'NUTS 2',
    adapter: 'eurostatRegionalLabourMarketAdapter',
  },
  {
    id: 'eea-environmental-noise-directive',
    label: 'EEA Environmental Noise Directive data',
    countries: ['eu'],
    capabilities: ['noise_airport', 'transport_network'],
    sourceUrl: 'https://www.eea.europa.eu/data-and-maps/data/data-on-noise-exposure-8',
    licenseNote: 'Europe-wide reported strategic noise exposure for major roads, railways, airports and agglomerations under the Environmental Noise Directive.',
    refreshCadence: 'five-year END reporting cycle / EEA releases',
    resolution: 'reported airport/road/rail/industry noise exposure and contour context',
    adapter: 'eeaEnvironmentalNoiseAdapter',
  },
  {
    id: 'eurocontrol-adrr',
    label: 'EUROCONTROL Aviation Data Repository for Research',
    countries: ['eu'],
    capabilities: ['flight_routes'],
    sourceUrl: 'https://www.eurocontrol.int/dashboard/aviation-data-research',
    licenseNote: 'Research access to planned and actual flight trajectories, airspace structure and route network data; access and usage terms must be checked before production use.',
    refreshCadence: 'provider release cadence',
    resolution: 'flight trajectory / route network',
    adapter: 'eurocontrolAdrrAdapter',
  },
  {
    id: 'opensky-network',
    label: 'OpenSky Network',
    countries: ['eu'],
    capabilities: ['flight_routes'],
    sourceUrl: 'https://opensky-network.org/data',
    licenseNote: 'Crowdsourced ADS-B/Mode S flight tracking data; useful for route density research, with coverage and licensing constraints.',
    refreshCadence: 'live / historical database',
    resolution: 'aircraft position observations / reconstructed trajectories',
    adapter: 'openskyFlightRouteAdapter',
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
