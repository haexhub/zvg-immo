---

description: "Task list for 006 Entfernung messen und Flurstücke auf der Detailkarte"
---

# Tasks: Entfernung messen und Flurstücke auf der Detailkarte

**Input**: Design documents from `specs/006-detail-map-measure-parcels/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/detail-map-ui.md, quickstart.md

**Tests**: Die Spec fordert keine Tests ausdrücklich. Die spaex-Constitution verlangt aber eine lauffähige Prüfung je nicht-trivialer Logik („Leave exactly one runnable check behind"). Deshalb hat jede Story genau eine Vitest-Datei für ihre reine Logik.

**Organization**: Aufgaben nach User Story gruppiert. Beide Stories sind unabhängig voneinander umsetzbar und testbar.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallel ausführbar (andere Dateien, keine offenen Abhängigkeiten)
- **[Story]**: US1 = Entfernung messen (P1), US2 = Flurstücke (P2)

## Phase 1: Setup

- [X] T001 Abhängigkeiten im Worktree installieren (`pnpm install --frozen-lockfile`) und den Ausgangszustand prüfen (`pnpm test`), damit spätere Fehler eindeutig dem Feature zuzuordnen sind

---

## Phase 2: Foundational

**Purpose**: Gemeinsame Voraussetzung beider Stories.

- [X] T002 In `components/Auction/DetailMap.client.vue` die optionalen Props `country?: string` und `region?: string` ergänzen (contracts/detail-map-ui.md) und in `components/Auction/DetailLocationSection.vue` `:country="auction.country"` und `:region="auction.region"` an `<AuctionDetailMap>` übergeben. Bisheriges Verhalten bleibt unverändert, wenn die Props fehlen.

**Checkpoint**: Karte rendert wie vorher.

---

## Phase 3: User Story 1 - Luftlinie zwischen zwei Punkten messen (Priority: P1) 🎯 MVP

**Goal**: Mess-Modus per Button. Zwei Einzelklicks setzen A und B, danach erscheinen Linie und geodätische km-Angabe. Ein dritter Klick startet neu, Esc oder der Button beenden den Modus. Popups sind währenddessen aus.

**Independent Test**: quickstart.md → „Manuell / Messen" sowie `pnpm test lib/distance-measure.test.ts`.

### Implementation for User Story 1

- [X] T003 [P] [US1] `lib/distance-measure.ts` anlegen und dort exportieren:
  - `type LngLat = [number, number]`, `interface MeasureState { a: LngLat | null; b: LngLat | null }` und `EMPTY_MEASURE`.
  - `nextMeasureState(state, point)` mit den Übergängen aus data-model.md: leer → `{a: p, b: null}`; `{a, b: null}` → `{a, b: p}`; fertig `{a, b}` → `{a: p, b: null}`.
  - `measureDistanceKm(a, b)` über `getDistance` aus `ol/sphere` (Eingabe `[lng, lat]`), Ergebnis / 1000.
  - `formatMeasuredKm(km, locale)` über `Intl.NumberFormat(locale, { maximumFractionDigits })`. Nachkommastellen: 2 bei < 10 km, 1 bei < 100 km, sonst 0. `0` ergibt „0".
  - `measureHintKey(active, state)`: `null` bei inaktivem Modus, sonst `map.measureHintStart`, `map.measureHintEnd` bzw. `map.measureHintRestart`.
- [X] T004 [P] [US1] `lib/distance-measure.test.ts` anlegen:
  - Berlin (13.405, 52.52) → München (11.582, 48.135) ≈ 504 km mit ±0,5 % Toleranz.
  - Gleicher Punkt → 0.
  - Übergangsfolge von `nextMeasureState`: leer → A → A+B → neues A.
  - `formatMeasuredKm(0.3456, 'de-DE')` → „0,35"; `formatMeasuredKm(123.4, 'en')` → „123".
  - `measureHintKey` für alle vier Fälle.
- [X] T005 [US1] `composables/useDetailMapDistanceMeasure.ts` anlegen (Muster: `composables/useDetailMapTourismLayers.ts`). Eingabe `{ map: ShallowRef<OlMap | null> }`, Rückgabe `{ active, hint, toggle, deactivate }`.
  - Sobald die Karte steht, eine `VectorLayer` mit `zIndex: 15` hinzufügen.
  - Im aktiven Modus auf `singleclick` hören: `evt.coordinate` mit `toLonLat` umrechnen, `nextMeasureState` anwenden, die Features neu aufbauen (Punkte für A/B, LineString A–B). Der `Text`-Style am LineString zeigt `t('map.measureDistanceKm', { km: formatMeasuredKm(…, intlLocale.value) })` mit weißem Halo.
  - Esc über `window`-`keydown` nur solange aktiv.
  - Ausschalten: Zustand auf `EMPTY_MEASURE` setzen, Features leeren, Listener entfernen. Bei Unmount dasselbe und die Layer entfernen.
  - `watch(intlLocale)` → `layer.changed()`.
  - `hint` = `computed` aus `measureHintKey` mit `t()`.
- [X] T006 [P] [US1] `components/Auction/DetailMapMeasureControl.vue` anlegen. Props `active: boolean`, `hint: string | null`, `toggleClass: string`, Event `toggle`.
  - `<button type="button" :aria-pressed="active">` mit Text `t('map.measureDistance')`. Aktiv: deutlich hervorgehoben, z. B. blauer Rand und Text.
  - Darunter ein `aria-live="polite"`-Element mit `hint`, nur wenn aktiv.
- [X] T007 [US1] In `components/Auction/DetailMap.client.vue` verdrahten:
  - `useDetailMapDistanceMeasure({ map: olMapRef })` aufrufen.
  - Im bestehenden `map.on('click')`-Handler als erste Zeile `if (measureActive.value) return` einfügen.
  - In `onMounted` nach dem Anlegen von `popupOverlay` per `watch(measureActive, a => { if (a) popupOverlay.setPosition(undefined) })` das Popup beim Einschalten schließen (FR-007).
  - `<AuctionDetailMapMeasureControl>` oben links einsetzen (`absolute top-2 left-2 z-10`) und `:toggle-class="controlToggleClass"` übergeben.
  - Den Karten-Container bei aktivem Modus mit `cursor-crosshair` versehen.
  - Datei muss ≤ 500 Zeilen bleiben.
- [X] T008 [P] [US1] i18n-Keys in `i18n/locales/de.json` und `i18n/locales/en.json` im Block `map` ergänzen:
  - `measureDistance` (de: „Entfernung messen", en: „Measure distance")
  - `measureHintStart` („Startpunkt in die Karte klicken" / „Click the map to set the start point")
  - `measureHintEnd` („Endpunkt klicken" / „Click to set the end point")
  - `measureHintRestart` („Klicken für neue Messung, Esc beendet" / „Click to start a new measurement, Esc to exit")
  - `measureDistanceKm` („{km} km")

**Checkpoint**: US1 vollständig nutzbar, unabhängig von US2.

---

## Phase 4: User Story 2 - Flurstücke rund um das Objekt sehen (Priority: P2)

**Goal**: Zuschaltbarer Layer „Flurstücke" im Layer-Panel für Auktionen in unterstützten Gebieten, aus amtlichen WMS-Diensten (research.md R7, plan.md Gate-Entscheidungen).

**Independent Test**: quickstart.md → „Manuell / Flurstücke" + „Negativfall" sowie `pnpm test lib/cadastral-parcels.test.ts`.

### Implementation for User Story 2

- [X] T009 [US2] Niedersachsen erneut prüfen. GetCapabilities und GetMap gegen `https://opendata.lgln.niedersachsen.de/doorman/noauth/alkis_wms` mit `LAYERS=adv_alkis_flurstuecke`, `CRS=EPSG:3857`, 512×512 PNG, ~250 m bbox um Hannover. Ebenso Spanien (`CP.CadastralParcel`) und CZ (`local-km-wms.asp`, `hranice_parcel,parcelni_cisla`) per GetMap verifizieren und dabei die `minZoom` für ES aus dessen `MaxScaleDenominator` bestimmen. NI nur aufnehmen, wenn das PNG nicht leer ist; das Ergebnis in research.md R7 nachtragen.
- [X] T010 [P] [US2] `lib/cadastral-parcels.ts` anlegen:
  - `interface CadastralParcelSource { id; url; layers; minZoom; attribution; opacity?; styles? }` laut contracts/detail-map-ui.md.
  - Tabelle aller Quellen mit ✅ aus research.md R7, also 15 Bundesländer (+NI je nach T009), FR, PL, CZ und ES. Schlüssel: Bundesland-Name (Typ `Bundesland` aus `lib/auction-costs.ts`) bzw. Ländercode.
  - Am SH-Eintrag als Kommentar den Lizenzkonflikt und die Operator-Entscheidung vom 2026-10-23 vermerken.
  - Bei FR `opacity: 0.7`.
  - Attributionen mit `new Date().getFullYear()`, wo die Lizenz ein Jahr verlangt.
  - `cadastralParcelSourceFor(country, region)`: `de` → `bundeslandFromRegion(region)` → Eintrag oder `null`; `fr`, `pl`, `cz`, `es` → nationaler Eintrag; sonst `null`.
  - Den `ponytail:`-Kommentar aus research.md R6 (kein Koordinaten-Fallback ohne Region) am DE-Zweig anbringen.
  - `cadastralParcelLayer(source)`: `new ImageLayer({ minZoom: source.minZoom, opacity: source.opacity ?? 1, source: new ImageWMS({ url, params: { LAYERS, STYLES: styles ?? '', VERSION: '1.3.0', FORMAT: 'image/png', TRANSPARENT: true }, ratio: 1.5, attributions }) })` ohne `crossOrigin`. Die Projektion kommt von der View (EPSG:3857).
- [X] T011 [P] [US2] `lib/cadastral-parcels.test.ts` anlegen:
  - `('de', 'Sachsen')` → id SN mit `minZoom` 18.1.
  - `('de', 'Schleswig-Holstein')` → Eintrag.
  - `('fr', '')`, `('pl', …)`, `('cz', …)` und `('es', …)` → nationaler Eintrag.
  - `('de', '')`, `('de', 'Unbekannt')`, `('at', 'Wien')`, `('it', 'Molise')`, `(undefined, undefined)` → `null`.
  - Für jede Quelle: `url` beginnt mit `https://`, `layers` und `attribution` sind nicht leer, `minZoom` liegt zwischen 0 und 20.
  - `cadastralParcelLayer` liefert einen Layer mit `getMinZoom() === source.minZoom`; die Quelle hat `VERSION` 1.3.0 und `crossOrigin` null bzw. undefined.
- [X] T012 [US2] In `components/Auction/DetailMap.client.vue` verdrahten:
  - Neue Funktion `addCadastralParcelLayer(entries)`. Sie ruft `cadastralParcelSourceFor(props.country, props.region)` und bei Treffer `addOverlayEntry(entries, t('objektDetail.mapLayerCadastralParcels'), cadastralParcelLayer(source), false, 'cadastral')`.
  - In `onMounted` direkt nach `addFloodRiskLayer(entries)` aufrufen; so liegt der Layer unter den Markern (FR-013).
  - In `toggleOverlay` beim Einschalten mit `entry.id === 'cadastral'` prüfen, ob `map.getView().getZoom()` unter `entry.layer.getMinZoom()` liegt, und dann auf `minZoom + 0.2` zoomen (`view.animate({ zoom, duration: 300 })`, research.md R5).
  - Datei muss ≤ 500 Zeilen bleiben.
- [X] T013 [P] [US2] i18n-Key `objektDetail.mapLayerCadastralParcels` in `i18n/locales/de.json` („Flurstücke") und `i18n/locales/en.json` („Cadastral parcels") ergänzen, neben den übrigen `mapLayer*`-Keys.

**Checkpoint**: US2 vollständig nutzbar; US1 unverändert.

---

## Phase 5: Polish & Cross-Cutting Concerns

- [X] T014 `pnpm test`, `pnpm typecheck` und `pnpm lint` im Worktree ausführen und alle Fehler beheben. Den Size-Gate prüfen: `wc -l` der geänderten und neuen Produktionsdateien muss jeweils ≤ 500 sein.
- [ ] T015 Die App starten (Skill `run` bzw. `pnpm dev`) und quickstart.md „Manuell" für Messen, Flurstücke (mindestens eine Auktion aus DE, FR und ES) und den Negativfall durchspielen, sofern lokal Daten verfügbar sind. Was nicht prüfbar war, im Abschlussbericht nennen.
- [X] T016 `graphify update .` ausführen.
- [X] T017 Commits nach Conventional Commits anlegen (`docs(spec): …` für specs/, `feat(detail-map): …` je Story), ohne Agenten-Referenzen und ohne Co-Authored-By-Trailer. Push und PR gegen `main` (Merge per rebase oder merge-commit, nicht squash).

---

## Dependencies & Execution Order

- **Setup (T001)** → **Foundational (T002)** → US1 und US2 unabhängig voneinander → **Polish**.
- **US1**:
  - T003, T004, T006 und T008 parallel.
  - T005 braucht T003.
  - T007 braucht T005, T006 und T008.
- **US2**:
  - T009 zuerst, weil es die Tabelle festlegt.
  - Danach T010, T011 und T013 parallel.
  - T012 braucht T010 und T013.
- US1 und US2 ändern beide `DetailMap.client.vue` (T007 bzw. T012). Diese zwei Tasks laufen deshalb nacheinander, alles andere kann parallel laufen.

## Parallel Example

```text
US1: T003 lib/distance-measure.ts | T004 lib/distance-measure.test.ts | T006 DetailMapMeasureControl.vue | T008 i18n map.*
US2: T010 lib/cadastral-parcels.ts | T011 lib/cadastral-parcels.test.ts | T013 i18n objektDetail.mapLayerCadastralParcels
```

## Implementation Strategy

- **MVP**: Phase 1–3 (US1). Das Messen funktioniert überall und hängt von keinem externen Dienst ab.
- **Inkrement 2**: US2 (Flurstücke), danach Polish.
- Beide Stories gehen in einen PR, als getrennte Commits je Story.
