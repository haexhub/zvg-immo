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
  | 'air_quality'
  | 'climate_normals'
  | 'flight_routes'
  | 'source_discovery'

export type ExternalDataConfigFieldType = 'url' | 'path' | 'number'

// One entry per adapter-constructor argument that today only comes from
// nuxt.config.ts's externalData.* runtime config (env-var-only, requires a
// redeploy to change). Declaring the field here is what makes a source
// admin-configurable from /settings — server/utils/external-data/config.ts
// resolves DB override > this runtimeConfigKey > defaultValue generically
// for every field of every source, and the /settings card renders whatever
// fields a source declares without per-source UI code.
export interface ExternalDataConfigField {
  /** Stored under this key in the source's app_settings row and passed
   *  through to the adapter factory in server/tasks/external-enrichment.ts. */
  key: string
  type: ExternalDataConfigFieldType
  /** Matches a property of nuxt.config.ts's runtimeConfig.externalData —
   *  the env-configured fallback when no DB override is set. */
  runtimeConfigKey: string
  /** The NUXT_EXTERNAL_DATA_* var backing runtimeConfigKey, shown in
   *  /settings so an operator can see how to set it via deployment config
   *  instead. */
  envVar: string
  defaultValue: string | number
  /** No value from DB, env or defaultValue → the source is left out of the
   *  adapter list entirely (same graceful-degrade contract nuxt.config.ts
   *  documents today for empty externalData.* values). */
  required?: boolean
}

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
  /** Present only for sources with a real adapter implementation — the ~13
   *  other registry entries are discovery/documentation only and have
   *  nothing to configure. */
  configFields?: ExternalDataConfigField[]
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
    configFields: [
      {
        key: 'cachePath',
        type: 'path',
        runtimeConfigKey: 'frDvfCachePath',
        envVar: 'NUXT_EXTERNAL_DATA_FR_DVF_CACHE_PATH',
        defaultValue: '',
        required: true,
      },
    ],
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
    configFields: [
      {
        key: 'geoJsonPath',
        type: 'path',
        runtimeConfigKey: 'euFloodRiskGeoJsonPath',
        envVar: 'NUXT_EXTERNAL_DATA_EU_FLOOD_RISK_GEO_JSON_PATH',
        defaultValue: '',
        required: true,
      },
      {
        key: 'maxCacheAgeDays',
        type: 'number',
        runtimeConfigKey: 'euFloodRiskMaxCacheAgeDays',
        envVar: 'NUXT_EXTERNAL_DATA_EU_FLOOD_RISK_MAX_CACHE_AGE_DAYS',
        // Just over a year: the polygon cache is refreshed monthly by
        // server/tasks/import-eu-flood-risk-cache.ts, so tripping this gate
        // means the importer has been failing for a long while — not that the
        // six-year Floods Directive cycle moved on. This is the only place the
        // default lives; eu-flood-risk.ts's isStale() treats an absent value
        // as "never stale".
        defaultValue: 400,
      },
    ],
  },
  // openstreetmap-overpass used to live here as a configurable source (live
  // Overpass endpoint + timeout). Replaced by a local PostGIS table
  // (osm_local_elements, server/utils/external-data/osm-location-context.ts)
  // loaded out-of-band by a standalone osm2pgsql job — nothing left to
  // configure, so no source entry (this array only ever surfaces
  // configurable sources; see configurableExternalDataSources() in
  // config.ts). Attribution for the returned LocationContext is still
  // OpenStreetMap's, hardcoded as SOURCE in osm-location-shared.ts.
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
    id: 'eurostat-regional-tourism-nights',
    label: 'Eurostat Nights Spent at Tourist Accommodation (NUTS 2)',
    countries: ['eu'],
    // Not a per-auction adapter — see server/tasks/external-enrichment.ts,
    // which wires sources by hardcoded id rather than iterating this array,
    // and computeExternalDataCoverage()'s fixed COVERAGE_SOURCE_IDS list.
    // This entry exists only to get the generic /settings config UI + cache
    // import trigger for free; it powers the search map's visitor-intensity
    // overlay (composables/useTourismVisitorLayer.ts), not auction records.
    capabilities: [],
    sourceUrl: 'https://ec.europa.eu/eurostat/databrowser/view/tour_occ_nin2/default/table',
    licenseNote: 'Official Eurostat statistics (tour_occ_nin2) joined with GISCO NUTS2 boundaries (Nuts2json, EUPL 1.2). Attribute both in the UI.',
    refreshCadence: 'annual (Eurostat) / monthly courtesy re-pull',
    resolution: 'NUTS 2 region, nights per km² (P_KM2)',
    adapter: 'eurostatRegionalTourismNightsAdapter',
    configFields: [
      {
        key: 'cachePath',
        type: 'path',
        runtimeConfigKey: 'eurostatTourismNutsCachePath',
        envVar: 'NUXT_EXTERNAL_DATA_EUROSTAT_TOURISM_NUTS_CACHE_PATH',
        defaultValue: '',
        required: true,
      },
      {
        key: 'maxCacheAgeDays',
        type: 'number',
        runtimeConfigKey: 'eurostatTourismNutsMaxCacheAgeDays',
        envVar: 'NUXT_EXTERNAL_DATA_EUROSTAT_TOURISM_NUTS_MAX_CACHE_AGE_DAYS',
        // Eurostat updates the underlying statistic at most a couple of
        // times a year; this only flags a long-broken importer, same
        // rationale as eu-flood-risk-areas's maxCacheAgeDays default.
        defaultValue: 400,
      },
    ],
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
    configFields: [
      {
        key: 'serviceBaseUrl',
        type: 'url',
        runtimeConfigKey: 'eeaNoiseServiceBaseUrl',
        envVar: 'NUXT_EXTERNAL_DATA_EEA_NOISE_SERVICE_BASE_URL',
        defaultValue: '',
        required: true,
      },
      {
        key: 'timeoutMs',
        type: 'number',
        runtimeConfigKey: 'eeaNoiseTimeoutMs',
        envVar: 'NUXT_EXTERNAL_DATA_EEA_NOISE_TIMEOUT_MS',
        defaultValue: 10_000,
      },
    ],
  },
  {
    id: 'cams-air-quality',
    label: 'Copernicus CAMS European Air Quality (via Open-Meteo)',
    countries: ['eu'],
    capabilities: ['air_quality'],
    sourceUrl: 'https://open-meteo.com/en/docs/air-quality-api',
    licenseNote: 'Copernicus Atmosphere Monitoring Service European air quality analysis, redistributed by Open-Meteo under CC-BY-4.0. Modelled on a ~11 km grid, so it describes the surrounding area rather than the parcel.',
    refreshCadence: 'hourly model runs',
    resolution: '~11 km CAMS grid cell around the auction coordinates',
    adapter: 'camsAirQualityAdapter',
    // Both fields carry a working default, so this source needs no admin setup
    // to function — unlike the keyed/endpoint-specific sources above, the API
    // is public and unauthenticated.
    configFields: [
      {
        key: 'serviceUrl',
        type: 'url',
        runtimeConfigKey: 'camsAirQualityServiceUrl',
        envVar: 'NUXT_EXTERNAL_DATA_CAMS_AIR_QUALITY_SERVICE_URL',
        defaultValue: 'https://air-quality-api.open-meteo.com/v1/air-quality',
        required: true,
      },
      {
        key: 'timeoutMs',
        type: 'number',
        runtimeConfigKey: 'camsAirQualityTimeoutMs',
        envVar: 'NUXT_EXTERNAL_DATA_CAMS_AIR_QUALITY_TIMEOUT_MS',
        defaultValue: 10_000,
      },
    ],
  },
  {
    id: 'open-meteo-climate-normals',
    label: 'Open-Meteo Historical Weather API (ERA5-Land climate normals)',
    countries: ['eu'],
    capabilities: ['climate_normals'],
    sourceUrl: 'https://open-meteo.com/en/docs/historical-weather-api',
    licenseNote: 'ERA5-Land reanalysis (Copernicus Climate Change Service, CC-BY-4.0) via Open-Meteo, aggregated here over the 1991–2020 reference period. Climate normals, not a forecast; modelled on a ~9-11 km grid, so it describes the surrounding area rather than the parcel.',
    refreshCadence: 'fetched once per 0.1° grid cell, never (normals do not go stale)',
    resolution: '0.1° ERA5-Land grid cell around the auction coordinates',
    adapter: 'openMeteoClimateNormalsAdapter',
    // Both fields carry a working default, so this source needs no admin setup
    // to function — same public/unauthenticated shape as cams-air-quality.
    configFields: [
      {
        key: 'serviceUrl',
        type: 'url',
        runtimeConfigKey: 'openMeteoClimateServiceUrl',
        envVar: 'NUXT_EXTERNAL_DATA_OPEN_METEO_CLIMATE_SERVICE_URL',
        defaultValue: 'https://archive-api.open-meteo.com/v1/archive',
        required: true,
      },
      {
        key: 'timeoutMs',
        type: 'number',
        runtimeConfigKey: 'openMeteoClimateTimeoutMs',
        envVar: 'NUXT_EXTERNAL_DATA_OPEN_METEO_CLIMATE_TIMEOUT_MS',
        // 30 years of daily data is a much bigger response than the other
        // Open-Meteo call in this file (current-weather air quality), so this
        // default is well above cams-air-quality's 10s.
        defaultValue: 30_000,
      },
    ],
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
    label: 'Copernicus EFFIS MODIS Burnt Area',
    countries: ['eu'],
    capabilities: ['hazard_wildfire'],
    sourceUrl: 'https://forest-fire.emergency.copernicus.eu/applications/data-and-services',
    licenseNote: 'JRC/Copernicus historical burnt-area record; a static susceptibility signal, not a live fire-danger forecast.',
    refreshCadence: 'new fire seasons added roughly annually / periodic re-pull',
    resolution: 'MODIS burnt-area polygons, 2016–present',
    adapter: 'copernicusEffisBurntAreaAdapter',
    configFields: [
      {
        key: 'cachePath',
        type: 'path',
        runtimeConfigKey: 'copernicusEffisCachePath',
        envVar: 'NUXT_EXTERNAL_DATA_COPERNICUS_EFFIS_CACHE_PATH',
        defaultValue: '',
        required: true,
      },
      {
        key: 'maxCacheAgeDays',
        type: 'number',
        runtimeConfigKey: 'copernicusEffisMaxCacheAgeDays',
        envVar: 'NUXT_EXTERNAL_DATA_COPERNICUS_EFFIS_MAX_CACHE_AGE_DAYS',
        defaultValue: 400,
      },
    ],
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
