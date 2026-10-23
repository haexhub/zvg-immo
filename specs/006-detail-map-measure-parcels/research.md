# Research: Entfernung messen und Flurstücke auf der Detailkarte

Stand der Dienstprüfung: 2026-10-23. Für jeden Dienst wurden GetCapabilities
ausgewertet und ein echter GetMap-Aufruf gemacht: PNG 512×512, TRANSPARENT,
EPSG:3857, Ausschnitt von etwa 250 m um einen Stadtpunkt im Gebiet.

## R1 Geodätische Distanz

- **Decision**: `getDistance` aus `ol/sphere`. Es rechnet Haversine auf dem WGS84-Radius 6 371 008,8 m und erwartet Eingaben als `[lng, lat]`.
- **Rationale**: OpenLayers ist schon installiert und auf der Karte ohnehin geladen. Die Abweichung zur Großkreis-Referenz ist für SC-002 vernachlässigbar (< 0,5 %).
- **Alternatives considered**:
  - Das private `distanceKm()` in `lib/auction-filters.ts:122` (Haversine, R = 6371 km) ist gleichwertig, aber nicht exportiert. Es zu exportieren oder zu verschieben, wäre eine Änderung am Filter-Modul ohne Mehrwert.
  - Vincenty/Ellipsoid ist genauer, als die Anforderung verlangt, und mehr Code.

## R2 Klick-Ereignis im Mess-Modus

- **Decision**: Das Mess-Modul hört auf `singleclick`. Der bestehende Popup-Handler (`click`) kehrt sofort zurück, solange der Modus aktiv ist.
- **Rationale**: Bei einem Doppelklick feuert `click` zweimal. Ohne diese Wahl würde ein Doppelklick-Zoom A und B auf denselben Punkt setzen. `singleclick` feuert nur bei echten Einzelklicks und erst nach dem Doppelklick-Fenster. Ziehen über `moveTolerance: 8` hinaus erzeugt gar keinen Klick, das erfüllt FR-008.
- **Alternatives considered**:
  - `ol/interaction/Draw` mit `maxPoints: 2` bringt eigenes Zeichen-Feedback und Styles mit, macht den Übergang „dritter Klick = neue Messung" aber umständlich. Zwei Punkte brauchen keine Draw-Interaktion.

## R3 Darstellung von Linie und Distanz

- **Decision**: Eine eigene `VectorLayer` mit `zIndex` über den Overlays und unter dem Objekt-Pin. Sie enthält ein Point-Feature je Messpunkt und ein LineString-Feature A–B. Die Distanz steht als `Text`-Style am Linien-Feature, mit weißem Halo.
  - Format: in km, in der Sprache der UI über `Intl.NumberFormat(intlLocale)`.
  - Nachkommastellen: zwei unter 10 km (≈ 10 m Auflösung, Edge Case „< 1 km"), eine unter 100 km, darüber keine.
- **Rationale**: Für einen Text an der Linie braucht es kein DOM-Overlay. Das hält das Modul klein.
- **Alternatives considered**:
  - Ein `ol/Overlay`-Tooltip ist mehr DOM- und Lifecycle-Code.
  - Die bestehende Funktion `formatDistance` schaltet unter 1 km auf Meter um. Die Spec verlangt aber immer km.

## R4 Flurstücksdienste: Layertyp

- **Decision**: `ImageLayer` + `ImageWMS` (`ratio: 1.5`) je Gebiet, ohne `crossOrigin`.
  - Die Layer-`minZoom` kommt je Quelle aus der `MaxScaleDenominator` des Dienstes.
  - Hinweis: OL zeigt einen Layer erst bei Zoom **größer als** `minZoom`.
- **Rationale**:
  - Die Dienste rendern jede Anfrage neu, als WMS und nicht als WMTS. Ein Bild je Ansicht statt 12–20 Kacheln schont die amtlichen Server. Polen verbietet „harvesting", Spanien ausdrücklich gekachelte Abrufe.
  - Ohne `crossOrigin` spielt CORS keine Rolle: OL liest keine Pixel zurück.
  - Ein Layer wird erst angefragt, wenn er sichtbar und über `minZoom` ist. Das erfüllt SC-005.
- **Alternatives considered**:
  - `TileWMS` cacht beim Verschieben besser, belastet die Server aber stärker. Beim spanischen Catastro wäre es sogar unzulässig.

## R5 Aktivieren unterhalb der Mindest-Zoomstufe

- **Decision**: Schaltet jemand „Flurstücke" ein, während die Ansicht unter der `minZoom` der Quelle liegt, zoomt die Karte auf `minZoom + 0.2` heran. Die aktuelle Mitte bleibt dabei erhalten.
- **Rationale**: Die Detailkarte startet bei Zoom 14. Fast alle Dienste zeichnen erst ab Zoom 16–18. Ohne Zoom sähe es so aus, als passiere beim Einschalten nichts.
- **Alternatives considered**:
  - Ein Hinweis „näher heranzoomen" braucht zusätzlichen UI-Zustand und einen Klick mehr.

## R6 Zuordnung Auktion → Gebiet

- **Decision**: Für `country === 'de'` liefert `bundeslandFromRegion(auction.region)` aus `lib/auction-costs.ts:213` das Bundesland. Bei anderen Ländern zählt nur der Ländercode. Ist keine Region erkennbar, gibt es keinen Layer.
- **Rationale**: Die deutschen Crawler (zvg-portal, zvbawu, kip, dga-ag, bima, mv-zvgcom) füllen `region` mit dem Namen des Bundeslands. Den Grunderwerbsteuer-Rechner speist schon derselbe Helfer.
  - `ponytail:` Fehlt die Region, gibt es keinen Flurstücks-Layer. Abhilfe wäre ein Punkt-in-Polygon-Test gegen die Bundeslandgrenzen. Das lohnt sich erst, wenn dabei eine messbare Zahl deutscher Auktionen ohne Region herauskommt.
- **Alternatives considered**:
  - Bundesland-Bounding-Boxes überlappen an den Grenzen, und Stadtstaaten liegen in Flächenländern.
  - Alle 16 Layer mit `extent` gleichzeitig anzufragen, wäre ein Vielfaches an Anfragen.

## R7 Geprüfte Dienste

Alle Dienste nutzen WMS 1.3.0, `CRS=EPSG:3857`, `FORMAT=image/png` und `TRANSPARENT=TRUE`. „minZoom" bedeutet: ab dieser Zoomstufe zeichnet der Dienst laut `MaxScaleDenominator`.

| Gebiet | URL | LAYERS | minZoom | Attribution | Status |
|---|---|---|---|---|---|
| BW | `https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ALKIS_Basis_transparent` | `nora:ALKIS_Basis_transparent,nora:ALKIS_Basis_Beschriftung_transparent` | 13.4 | © LGL-BW, dl-de/by-2-0 | ✅ |
| BY | `https://geoservices.bayern.de/od/wms/alkis/v1/parzellarkarte` | `by_alkis_parzellarkarte_umr_schwarz` | 16.8 | © Bayerische Vermessungsverwaltung, CC BY 4.0 | ✅ Gebäude und Straßennamen sind enthalten |
| BE | `https://gdi.berlin.de/services/wms/alkis_flurstuecke` | `flurstuecke` | – | Geoportal Berlin, dl-de/zero-2-0 | ✅ ohne Nummern |
| BB | `https://isk.geobasis-bb.de/ows/alkis_wms` | `adv_alkis_flurstuecke` | 15.9 | © GeoBasis-DE/LGB, dl-de/by-2-0 | ✅ |
| HB | `https://geodienste.bremen.de/wms_inspire_cp_alkis` | `cp_cadastralparcel` | – | © Landesamt GeoInformation Bremen, CC BY | ✅ ohne Nummern |
| HH | `https://geodienste.hamburg.de/HH_WMS_ALKIS_Basiskarte` | `19,25` | 16.0 (Nummern ab 17.8) | © FHH, LGV, dl-de/by-2-0 | ✅ |
| HE | `https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-maps.ows` | `he_alk_t` | 15.9 | © HVBG | ✅ Gebäude sind enthalten |
| MV | `https://www.geodaten-mv.de/dienste/alkis_wms` | `adv_alkis_flurstuecke` | 16.8 | © GeoBasis-DE/M-V | ✅ |
| NI | `https://opendata.lgln.niedersachsen.de/doorman/noauth/alkis_wms` | (vermutlich `adv_alkis_flurstuecke`) | ? | © GeoBasis-DE/LGLN, dl-de/by-2-0 | ⛔ T009 (2026-10-23): weiterhin Wartungsseite, nicht aufgenommen |
| NW | `https://www.wms.nrw.de/geobasis/wms_nw_alkis` | `adv_alkis_flurstuecke` | 16.6 | © GeoBasis-DE/NRW, dl-de/zero-2-0 | ✅ |
| RP | `https://geo5.service24.rlp.de/wms/liegenschaften_rp.fcgi` | `Flurstueck` | 16.3 | © GeoBasis-DE/LVermGeoRP, dl-de/by-2-0 | ✅ |
| SL | `https://geoportal.saarland.de/gdi-sl/inspirewms_Flurstuecke_Grundstuecke_ALKIS` | `CP.CadastralParcel` | 16.0 | © LVGL, dl-de/by-2-0 | ✅ |
| SN | `https://geodienste.sachsen.de/wms_geosn_alkis-adv/guest` | `adv_alkis_flurstuecke` | 18.1 | © GeoBasis-DE/GeoSN, dl-de/by-2-0 | ✅ Lizenzseite gibt 404; maßgeblich ist das Nutzungs-PDF „ALKIS-WMS-Nutzung V6.0" |
| ST | `https://www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_ALKIS_WMS_AdV_konform_App/guest` | `adv_alkis_flurstuecke` | 16.8 | © GeoBasis-DE/LVermGeo ST, dl-de/by-2-0 | ✅ |
| SH | `https://service.gdi-sh.de/WMS_SH_ALKIS_OpenGBD` | `adv_alkis_flurstuecke` | 18.1 | © GeoBasis-DE/LVermGeo SH, CC BY 4.0 | ✅ Operator-Entscheidung trotz Lizenzkonflikt (siehe unten) |
| TH | `https://www.geoproxy.geoportal-th.de/geoproxy/services/adv_alkis_wms_th` | `adv_alkis_flurstuecke` | 15.9 | © GDI-Th, CC BY 4.0 | ✅ |
| FR | `https://data.geopf.fr/wms-r/wms` | `CADASTRALPARCELS.PARCELLAIRE_EXPRESS` | 15 (bei Zoom 15 getestet; laut Dienst ab 1:1066, getestet bis 1:837) | © IGN, Licence Ouverte (Etalab) | ✅ Gebäude sind gefüllt, Deckkraft 0.7 |
| IT | `https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php` | `CP.CadastralParcel,codice_plla` | 16.8 | © Agenzia delle Entrate, CC BY 4.0 | ⛔ kein EPSG:3857, kein CORS, Folge-Feature |
| PL | `https://integracja.gugik.gov.pl/cgi-bin/KrajowaIntegracjaEwidencjiGruntow` | `dzialki,numery_dzialek` | 15.9 (Nummern ab 18.5) | © GUGiK | ✅ |
| ES | `https://ovc.catastro.meh.es/cartografia/INSPIRE/spadgcwms.aspx` | `CP.CadastralParcel` | 15 (Dienst ohne Maßstabsgrenze) | © Dirección General del Catastro | ✅ nur Einzelbilder, keine Kacheln (passt zu R4) |
| CZ | `https://services.cuzk.gov.cz/wms/local-km-wms.asp` | `hranice_parcel,parcelni_cisla` | 16.8 | © ČÚZK | ✅ Alternative ohne Nummern: `inspire-cp-wms.asp`, ab 14.6 |

Offene Punkte zum Zeitpunkt der Prüfung. Die Entscheidungen dazu stehen in plan.md unter „Gate-Entscheidungen":

- **IT**: Der Dienst liefert nur EPSG:4258/6706/25832 usw. Ohne CORS kann OL das Bild nicht reprojizieren, weil der Canvas „tainted" wäre. Nutzbar ist Italien nur über einen Server-Proxy der App, der Bilder abruft und reprojiziert oder wenigstens CORS ergänzt. Das ist neue Server-Last und ein neuer öffentlicher Endpunkt. **Vorschlag**: in diesem Feature nicht umsetzen.
- **SH**: Laut Metadatenkatalog gilt CC BY 4.0. Die Fees in den Live-Capabilities sagen aber: „permanentes Einbinden des Dienstes in Webanwendungen ist nicht zulässig" (schriftliche Zustimmung nötig). **Vorschlag**: zurückstellen, bis die Lizenz geklärt ist.
- **NI**: Der Dienst war während der Prüfung im Wartungsmodus. **Vorschlag**: Bei der Umsetzung erneut prüfen. Funktioniert GetMap dann mit `adv_alkis_flurstuecke`, nehme ich NI auf, sonst nicht.
- **Spanien (Bonus, nicht beauftragt)**: Funktioniert mit `CP.CadastralParcel` in EPSG:3857. Gekachelte Abrufe sind verboten, deshalb passt `ImageWMS` (R4). Spanien ließe sich ohne Mehraufwand mitnehmen.

## R8 Attribution

- **Decision**: Die Attribution ist je Quelle fest im Code hinterlegt und hängt an der OL-`attributions` der `ImageWMS`-Quelle. Sie erscheint also nur, solange der Layer sichtbar ist. Wo die Lizenz es verlangt (dl-de/by), steht das aktuelle Jahr darin.
- **Rationale**: Keiner der deutschen Dienste füllt `<Attribution>` in den Capabilities.

## R9 Nachprüfung bei der Umsetzung (T009)

- **NI**: GetCapabilities und GetMap liefern weiterhin die HTML-Wartungsseite (832 B). Niedersachsen wird nicht aufgenommen; die Stelle ist in `lib/cadastral-parcels.ts` markiert.
- **ES**: Der Catastro beantwortet Anfragen mit curl-User-Agent mit einer HTML-Seite, mit Browser-User-Agent mit einem PNG (42 KB bei Zoom 15). In der App lädt der Browser die Bilder, also ist das kein Problem. Der Dienst nennt keine Maßstabsgrenzen; Mindestzoom 15.
- **CZ**: `local-km-wms.asp` mit `hranice_parcel,parcelni_cisla` liefert ein PNG (10,9 KB).
- **FR**: zeichnet schon bei Zoom 15 (206 KB); Mindestzoom 15 statt 17.
