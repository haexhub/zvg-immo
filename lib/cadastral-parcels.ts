import ImageLayer from 'ol/layer/Image'
import ImageWMS from 'ol/source/ImageWMS'
import { bundeslandFromRegion, type Bundesland } from '~/lib/auction-costs'

/** One official cadastral-parcel WMS for the detail map's "Flurstücke"
 *  overlay. Every entry was checked with a real EPSG:3857 GetMap request on
 *  2026-10-23 (specs/006-detail-map-measure-parcels/research.md R7). */
export interface CadastralParcelSource {
  id: string
  url: string
  layers: string
  /** Zoom from which the service draws anything, from its
   *  MaxScaleDenominator (z = log2(156543 / (scale × 0.00028))); services
   *  without a limit start at 15 to keep request volume down. */
  minZoom: number
  attribution: string
  opacity?: number
  styles?: string
}

const year = new Date().getFullYear()

// Niedersachsen is missing: its open-data WMS (opendata.lgln.niedersachsen.de)
// answered every request with a maintenance page during the 2026-10-23 checks.
// Add it once GetMap with adv_alkis_flurstuecke returns a PNG again.
const GERMAN_SOURCES: Partial<Record<Bundesland, CadastralParcelSource>> = {
  'Baden-Württemberg': {
    id: 'de-bw',
    url: 'https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ALKIS_Basis_transparent',
    layers: 'nora:ALKIS_Basis_transparent,nora:ALKIS_Basis_Beschriftung_transparent',
    minZoom: 13.4,
    attribution: `© LGL-BW ${year}, dl-de/by-2-0, www.lgl-bw.de`,
  },
  'Bayern': {
    id: 'de-by',
    url: 'https://geoservices.bayern.de/od/wms/alkis/v1/parzellarkarte',
    layers: 'by_alkis_parzellarkarte_umr_schwarz',
    minZoom: 16.8,
    attribution: `© Bayerische Vermessungsverwaltung ${year}, CC BY 4.0`,
  },
  // alkis_flurstuecke has boundaries only, no parcel numbers; the full
  // /services/wms/alkis raster is opaque and unusable as an overlay.
  'Berlin': {
    id: 'de-be',
    url: 'https://gdi.berlin.de/services/wms/alkis_flurstuecke',
    layers: 'flurstuecke',
    styles: 'alkis_flurstuecke',
    minZoom: 15,
    attribution: '© Geoportal Berlin / ALKIS Berlin, dl-de/zero-2-0',
  },
  'Brandenburg': {
    id: 'de-bb',
    url: 'https://isk.geobasis-bb.de/ows/alkis_wms',
    layers: 'adv_alkis_flurstuecke',
    minZoom: 15.9,
    attribution: `© GeoBasis-DE/LGB ${year}, dl-de/by-2-0`,
  },
  // INSPIRE service: boundaries only, no parcel numbers.
  'Bremen': {
    id: 'de-hb',
    url: 'https://geodienste.bremen.de/wms_inspire_cp_alkis',
    layers: 'cp_cadastralparcel',
    minZoom: 15,
    attribution: '© Landesamt GeoInformation Bremen, CC BY 4.0',
  },
  // ArcGIS-backed WMS with numeric layer names: 19 = Flurstücksumringe,
  // 25 = Flurstücksnummern (the latter only from z17.8).
  'Hamburg': {
    id: 'de-hh',
    url: 'https://geodienste.hamburg.de/HH_WMS_ALKIS_Basiskarte',
    layers: '19,25',
    minZoom: 16,
    attribution: `© Freie und Hansestadt Hamburg, LGV ${year}, dl-de/by-2-0`,
  },
  'Hessen': {
    id: 'de-he',
    url: 'https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-maps.ows',
    layers: 'he_alk_t',
    minZoom: 15.9,
    attribution: '© Hessische Verwaltung für Bodenmanagement und Geoinformation',
  },
  'Mecklenburg-Vorpommern': {
    id: 'de-mv',
    url: 'https://www.geodaten-mv.de/dienste/alkis_wms',
    layers: 'adv_alkis_flurstuecke',
    minZoom: 16.8,
    attribution: `© GeoBasis-DE/M-V ${year}`,
  },
  'Nordrhein-Westfalen': {
    id: 'de-nw',
    url: 'https://www.wms.nrw.de/geobasis/wms_nw_alkis',
    layers: 'adv_alkis_flurstuecke',
    minZoom: 16.6,
    attribution: `© GeoBasis-DE/NRW ${year}, dl-de/zero-2-0`,
  },
  'Rheinland-Pfalz': {
    id: 'de-rp',
    url: 'https://geo5.service24.rlp.de/wms/liegenschaften_rp.fcgi',
    layers: 'Flurstueck',
    minZoom: 16.3,
    attribution: `© GeoBasis-DE/LVermGeoRP ${year}, dl-de/by-2-0, www.lvermgeo.rlp.de`,
  },
  'Saarland': {
    id: 'de-sl',
    url: 'https://geoportal.saarland.de/gdi-sl/inspirewms_Flurstuecke_Grundstuecke_ALKIS',
    layers: 'CP.CadastralParcel',
    minZoom: 16,
    attribution: `© LVGL ${year}, dl-de/by-2-0, www.lvgl.saarland.de`,
  },
  'Sachsen': {
    id: 'de-sn',
    url: 'https://geodienste.sachsen.de/wms_geosn_alkis-adv/guest',
    layers: 'adv_alkis_flurstuecke',
    minZoom: 18.1,
    attribution: `© GeoBasis-DE/GeoSN ${year}, dl-de/by-2-0`,
  },
  'Sachsen-Anhalt': {
    id: 'de-st',
    url: 'https://www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_ALKIS_WMS_AdV_konform_App/guest',
    layers: 'adv_alkis_flurstuecke',
    minZoom: 16.8,
    attribution: `© GeoBasis-DE/LVermGeo ST ${year}, dl-de/by-2-0`,
  },
  // Licence conflict, accepted by the operator on 2026-10-23: the metadata
  // catalogue lists CC BY 4.0, but the live capabilities' Fees text still says
  // permanently embedding the service in web applications needs written
  // consent from LVermGeo SH. Drop this entry if LVermGeo SH objects.
  'Schleswig-Holstein': {
    id: 'de-sh',
    url: 'https://service.gdi-sh.de/WMS_SH_ALKIS_OpenGBD',
    layers: 'adv_alkis_flurstuecke',
    minZoom: 18.1,
    attribution: `© GeoBasis-DE/LVermGeo SH ${year}, CC BY 4.0`,
  },
  'Thüringen': {
    id: 'de-th',
    url: 'https://www.geoproxy.geoportal-th.de/geoproxy/services/adv_alkis_wms_th',
    layers: 'adv_alkis_flurstuecke',
    minZoom: 15.9,
    attribution: `© GDI-Th ${year}, CC BY 4.0`,
  },
}

// Italy is deliberately absent: Agenzia delle Entrate's WMS offers no
// EPSG:3857 and sends no CORS header, so OpenLayers can neither request it in
// the view projection nor reproject it client-side — it needs a server proxy.
const NATIONAL_SOURCES: Record<string, CadastralParcelSource> = {
  // Fills buildings as solid areas, hence the reduced opacity.
  fr: {
    id: 'fr',
    url: 'https://data.geopf.fr/wms-r/wms',
    layers: 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS',
    minZoom: 15,
    opacity: 0.7,
    attribution: '© IGN – Parcellaire Express, Licence Ouverte Etalab',
  },
  pl: {
    id: 'pl',
    url: 'https://integracja.gugik.gov.pl/cgi-bin/KrajowaIntegracjaEwidencjiGruntow',
    layers: 'dzialki,numery_dzialek',
    minZoom: 15.9,
    attribution: '© GUGiK – Krajowa Integracja Ewidencji Gruntów',
  },
  cz: {
    id: 'cz',
    url: 'https://services.cuzk.gov.cz/wms/local-km-wms.asp',
    layers: 'hranice_parcel,parcelni_cisla',
    minZoom: 16.8,
    attribution: '© ČÚZK',
  },
  // The Catastro's AccessConstraints forbid tiled requests — fine here, since
  // cadastralParcelLayer() fetches one image per view.
  es: {
    id: 'es',
    url: 'https://ovc.catastro.meh.es/cartografia/INSPIRE/spadgcwms.aspx',
    layers: 'CP.CadastralParcel',
    minZoom: 15,
    attribution: '© Dirección General del Catastro',
  },
}

export function cadastralParcelSourceFor(country?: string | null, region?: string | null): CadastralParcelSource | null {
  const code = country?.toLowerCase()
  if (code === 'de') {
    // ponytail: German auctions are matched by their crawled Bundesland name
    // only, so one without a region gets no parcel layer. Upgrade path: a
    // point-in-polygon lookup of lat/lng against the Bundesland boundaries,
    // once region-less German auctions show up in measurable numbers.
    const bundesland = bundeslandFromRegion(region)
    return bundesland ? GERMAN_SOURCES[bundesland] ?? null : null
  }
  return code ? NATIONAL_SOURCES[code] ?? null : null
}

/** One WMS image per view (ImageWMS, not TileWMS): these services render every
 *  request from scratch, so 12–20 tiles per view would multiply their load.
 *  No crossOrigin — OpenLayers never reads the pixels back, so CORS is moot. */
export function cadastralParcelLayer(source: CadastralParcelSource): ImageLayer<ImageWMS> {
  return new ImageLayer({
    minZoom: source.minZoom,
    opacity: source.opacity ?? 1,
    source: new ImageWMS({
      url: source.url,
      params: {
        LAYERS: source.layers,
        STYLES: source.styles ?? '',
        VERSION: '1.3.0',
        FORMAT: 'image/png',
        TRANSPARENT: true,
      },
      ratio: 1.5,
      attributions: source.attribution,
    }),
  })
}

export const CADASTRAL_PARCEL_SOURCES: readonly CadastralParcelSource[] = [
  ...Object.values(GERMAN_SOURCES),
  ...Object.values(NATIONAL_SOURCES),
]
