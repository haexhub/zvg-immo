# Implementation Plan: Entfernung messen und Flurstücke auf der Detailkarte

**Branch**: `006-detail-map-measure-parcels` | **Date**: 2026-10-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/006-detail-map-measure-parcels/spec.md`

## Summary

Die Detailkarte (`components/Auction/DetailMap.client.vue`, OpenLayers) bekommt
zwei Ergänzungen:

1. **Mess-Modus**: Ein Button schaltet ihn ein. Danach setzen zwei Einzelklicks die Punkte A und B. Linie und geodätische km-Angabe zeichnet eine eigene Vektorebene; die Distanz kommt von `ol/sphere` `getDistance`.
2. **Flurstücks-Overlay**: Ein `ImageWMS`-Layer erscheint im bestehenden Layer-Panel. Die Quelle wählt eine statische Tabelle amtlicher WMS-Dienste nach Land bzw. Bundesland.

Keine neue Abhängigkeit, kein Server-Code und keine Persistenz.

## Technical Context

**Language/Version**: TypeScript (strict), Vue 3 `<script setup>` in Nuxt

**Primary Dependencies**: `ol` (schon installiert): `ol/sphere`, `ol/source/ImageWMS`, `ol/layer/Image`, `ol/style/Text`. Dazu `vue-i18n` über Nuxt-i18n.

**Storage**: N/A, nur Zustand im Browser

**Testing**: Vitest (`environment: 'node'`, `pnpm test`), Unit-Tests für reine Logik in `lib/*.test.ts`. Typecheck und Lint wie in CI.

**Target Platform**: Browser, Desktop und Mobil. Die Karte ist `.client.vue`.

**Project Type**: Web-App (Nuxt, SSR + Client-Komponenten)

**Performance Goals**:
- Ist der Flurstücks-Layer aus, gehen keine Anfragen an Flurstücksdienste (SC-005).
- Ist er an, gibt es eine WMS-Anfrage je Ansicht und keine Kacheln.

**Constraints**:
- Produktionsdateien höchstens 500 Zeilen. `DetailMap.client.vue` hat schon 465, deshalb kommt neue Logik in eigene Module.
- Keine API-Schlüssel und keine kostenpflichtigen Dienste.

**Scale/Scope**:
- Neue Module: 2 Lib-Module, 1 Composable, 1 kleine Komponente.
- Geändert: 2 Komponenten und 2 Locale-Dateien (`de`, `en`).
- Flurstücksquellen: 15 Bundesländer (NI bedingt, dann 16) sowie FR, PL, CZ und ES (siehe Gate-Entscheidungen).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Grundlage ist `.spaex/constitution.md`; `.specify/memory/constitution.md` ist nur ein unausgefülltes Template.

| Regel | Bewertung |
|---|---|
| Worktree und Topic-Branch, PR auf `main`, kein Squash | ✅ Worktree `.worktrees/006-detail-map-measure-parcels`, Branch `006-detail-map-measure-parcels` |
| Graph konsultieren vor neuen Artefakten, Erweitern statt Duplizieren | ✅ Geprüft: `distanceKm` (`lib/auction-filters.ts:122`, privat), `formatDistance` (`composables/useAuctionDetailFormatters.ts:60`, wechselt auf Meter), `arcGisMapLayer` (`lib/arcgis-export-layer.ts`, ArcGIS-REST statt WMS), `bundeslandFromRegion` (`lib/auction-costs.ts:213`, wird **wiederverwendet**), `addOverlayEntry` (wird **wiederverwendet**). Begründung je Fall in research.md R1, R3 und R6 |
| Laziness ladder, keine neue Abhängigkeit | ✅ Alles mit `ol`. Keine Draw-Interaktion (R2) und kein DOM-Tooltip (R3) |
| höchstens 500 LoC je Datei | ✅ Neue Logik in eigenen Modulen. `DetailMap.client.vue` wächst nur um die Verdrahtung (~20 Zeilen) |
| Tests getrennt von Produktionscode, eine lauffähige Prüfung je nicht-trivialer Logik | ✅ `lib/distance-measure.test.ts`, `lib/cadastral-parcels.test.ts` |
| Validierung an Vertrauensgrenzen | ✅ Keine neuen Eingaben von außen. Die WMS-Bilder rendert der Browser nur, OL liest keine Pixel |
| Conventional Commits, keine Agenten-Referenzen in Artefakten | ✅ Commit-Typ `feat(detail-map)`. Hinweis: Die Co-Authored-By-Zeile aus dem Harness entfällt, weil die Constitution (MUST_NOT) Vorrang hat |
| `ponytail:` für bewusste Vereinfachungen | ✅ Region-basierte Zuordnung ohne Koordinaten-Fallback (R6) |
| Phasing | ✅ Reines UI-Additiv ohne Abhängigkeit von späteren Phasen |

Ergebnis: **PASS**, keine Verstöße. Complexity Tracking entfällt.

## Project Structure

### Documentation (this feature)

```text
specs/006-detail-map-measure-parcels/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── detail-map-ui.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
lib/
├── distance-measure.ts          # NEU: MeasureState, nextMeasureState, measureDistanceKm, formatMeasuredKm
├── distance-measure.test.ts     # NEU
├── cadastral-parcels.ts         # NEU: Quellen-Tabelle, cadastralParcelSourceFor, cadastralParcelLayer
└── cadastral-parcels.test.ts    # NEU

composables/
└── useDetailMapDistanceMeasure.ts  # NEU: OL-Verdrahtung (Vektorebene, singleclick, Esc, Styles)

components/Auction/
├── DetailMapMeasureControl.vue  # NEU: Button + Hinweiszeile
├── DetailMap.client.vue         # GEÄNDERT: Props country/region, Parcel-Overlay-Eintrag, Measure-Composable, Popup-Guard
└── DetailLocationSection.vue    # GEÄNDERT: reicht auction.country / auction.region durch

i18n/locales/{de,en}.json        # GEÄNDERT: map.measure*, objektDetail.mapLayerCadastralParcels
```

**Structure Decision**: Die bestehende Nuxt-Struktur bleibt.
- Reine, testbare Logik liegt in `lib/`, die OL-Lifecycle-Verdrahtung in `composables/`, Darstellung in `components/Auction/`.
- Das folgt dem Muster von `useDetailMapTourismLayers` bzw. `lib/auction-map-overlays.ts`.

## Design-Entscheidungen im Detail

### Mess-Modus

- `useDetailMapDistanceMeasure({ map: olMapRef })` gibt `{ active, hintKey, toggle, deactivate }` zurück.
  - Die eigene `VectorLayer` hat `zIndex: 15`: über den Hover-Layern (10), unter dem Objekt-Pin (20).
  - Die Ebene wird beim Setzen von `map` angelegt.
- Listener:
  - `singleclick` auf der Karte, nur bei `active`.
  - `keydown` (Esc) auf `window`, nur solange `active`.
  - Beide werden beim Ausschalten und bei Unmount entfernt.
- Der bestehende `map.on('click')`-Popup-Handler bekommt den Guard `if (measureActive.value) return`. Ein `watch(active)` schließt beim Einschalten das offene Popup (FR-007).
- Solange der Modus aktiv ist, bekommt der Kartencontainer `cursor-crosshair`.
- Das Label hängt als `Text`-Style am LineString. Ein Locale-Wechsel ändert `formatMeasuredKm` über `intlLocale` und löst `layer.changed()` aus (Edge Case Locale).
- Die Linie ist im Bild gerade (Web Mercator), die Zahl geodätisch. Bei Strecken über einige 100 km liegt die gezeichnete Linie damit nicht exakt auf dem Großkreis. Das ist bewusst so: Die Spec verlangt die korrekte Zahl, nicht die Kurve.

### Flurstücke

- `DetailMap` bekommt die Props `country?: string` und `region?: string`.
- `cadastralParcelSourceFor(country, region)` liefert eine Quelle oder `null`.
  - Bei einer Quelle legt `addOverlayEntry(entries, t('objektDetail.mapLayerCadastralParcels'), cadastralParcelLayer(source), false, 'cadastral')` den Eintrag an. Er ist standardmäßig aus (FR-010).
  - Bei `null` gibt es keinen Eintrag (FR-012).
- Zoom beim Einschalten (R5): `toggleOverlay` prüft für `entry.id === 'cadastral'`, ob die View unter `layer.getMinZoom()` liegt, und animiert dann auf `minZoom + 0.2`.
- Stapelreihenfolge: Der Layer liegt in `entries` vor den Feature-, Hazard- und Geruchs-Layern. Er wird direkt nach dem Hochwasser-Layer eingefügt und bleibt damit unter allen Markern und dem Pin (FR-013).

### i18n

Neue Keys in `de` und `en`:
- `map.measureDistance`
- `map.measureHintStart`
- `map.measureHintEnd`
- `map.measureHintRestart`
- `map.measureDistanceKm` (`{km} km`)
- `objektDetail.mapLayerCadastralParcels`

## Gate-Entscheidungen (Operator, 2026-10-23)

1. **Italien**: entfällt in diesem Feature und folgt als eigenes Feature mit Server-Proxy (kein EPSG:3857, kein CORS).
2. **Schleswig-Holstein**: wird aufgenommen. Der Operator stützt sich auf CC BY 4.0 laut Metadatenkatalog und trägt das Lizenzrisiko, obwohl der Fees-Text des Live-Dienstes widerspricht. Der Konflikt wird im Quellcode-Kommentar des SH-Eintrags vermerkt.
3. **Niedersachsen**: wird bei der Umsetzung erneut geprüft und nur aufgenommen, wenn GetMap funktioniert.
4. **Spanien** (Catastro): wird zusätzlich aufgenommen.

Damit gibt es 16 bzw. 17 Flurstücksquellen: 15 Bundesländer (+NI bedingt), FR, PL, CZ, ES.

## Complexity Tracking

Keine Verstöße, entfällt.
