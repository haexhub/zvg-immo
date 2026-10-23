---

description: "Task list for 007 Dauerhafte Entfernungsmessungen auf der Detailkarte"
---

# Tasks: Dauerhafte Entfernungsmessungen auf der Detailkarte

**Input**: Design documents from `specs/007-detail-map-persistent-measurements/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/detail-map-ui.md, quickstart.md

**Tests**: Die Spec fordert keine ausdrücklich. Die spaex-Constitution verlangt aber eine lauffähige Prüfung je nicht-trivialer Logik. Deshalb wird `lib/distance-measure.test.ts` auf das neue Modell umgestellt und erweitert. Die OL-Verdrahtung läuft nur im Browser und wird nach quickstart.md geprüft.

**Organization**: Nach User Story gruppiert. Alle Befehle laufen innerhalb der Nix-Shell: `nix develop --command bash -c '<befehl>'`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallel ausführbar (andere Dateien, keine offenen Abhängigkeiten)
- **[Story]**: US1 = Mehrere Messungen gleichzeitig sehen (P1), US2 = Einzelne Messung entfernen (P2)

## Phase 1: Setup

- [X] T001 Im Worktree `.worktrees/007-detail-map-persistent-measurements` `pnpm install --frozen-lockfile`, `pnpm run prepare:nuxt` und `pnpm test` ausführen, damit der Ausgangszustand grün ist und spätere Fehler dem Feature zuzuordnen sind

---

## Phase 2: Foundational

**Purpose**: Das neue Zustandsmodell, auf dem beide Stories aufbauen.

- [X] T002 In `lib/distance-measure.ts` das Zustandsmodell nach data-model.md umbauen:
  - `interface Measurement { id: number; a: LngLat; b: LngLat }` und `MeasureState = { measurements: Measurement[]; pending: LngLat | null; nextId: number }`.
  - `EMPTY_MEASURE = { measurements: [], pending: null, nextId: 1 }`. Jede Funktion gibt einen neuen Zustand zurück und verändert die Eingabe nie.
  - `addMeasurePoint(state, point)`: ohne `pending` wird der Punkt zu `pending`, sonst entsteht `{id: nextId, a: pending, b: point}` am Ende von `measurements`, `pending` wird `null`, `nextId` steigt um 1.
  - `removeMeasurement(state, id)`: entfernt genau die Messung mit dieser `id`, `pending` bleibt; eine unbekannte `id` gibt den Zustand unverändert zurück (dieselbe Referenz).
  - `discardPending(state)`: `pending = null`, `measurements` unverändert.
  - `measureHintKey(active, state)`: `null` bei inaktivem Modus, `map.measureHintStart` ohne `pending`, sonst `map.measureHintEnd`. Der Key `map.measureHintRestart` entfällt.
  - `nextMeasureState` entfernen. `measureDistanceKm` und `formatMeasuredKm` bleiben unverändert.
- [X] T003 In `lib/distance-measure.test.ts` die Tests auf das neue Modell umstellen:
  - Die `nextMeasureState`-Tests durch `addMeasurePoint`-Tests ersetzen: erster Punkt → `pending`, zweiter → eine Messung mit `id` 1, ein dritter Punkt lässt die erste Messung bestehen und setzt `pending`.
  - `removeMeasurement`: entfernt nur die gemeinte Messung, auch wenn zwei Messungen dieselbe Entfernung haben; `pending` bleibt; unbekannte `id` → gleiche Referenz.
  - `discardPending` lässt `measurements` stehen.
  - `measureHintKey`: drei Fälle (aus, ohne `pending`, mit `pending`).
  - Die Tests für `measureDistanceKm` und `formatMeasuredKm` unverändert lassen.

**Checkpoint**: `pnpm test lib/distance-measure.test.ts` grün. Das Composable kompiliert erst nach T004.

---

## Phase 3: User Story 1 - Mehrere Messungen gleichzeitig sehen (Priority: P1) 🎯 MVP

**Goal**: Abgeschlossene Messungen bleiben sichtbar, auch nach einer neuen Messung und nach dem Beenden des Mess-Modus. Jede Linie trägt ihre eigene Entfernung. Nur ein angefangener Punkt A wird beim Beenden verworfen.

**Independent Test**: quickstart.md Schritte 1–3 und `pnpm test lib/distance-measure.test.ts`.

### Implementation for User Story 1

- [X] T004 [US1] `composables/useDetailMapDistanceMeasure.ts` auf mehrere Messungen umbauen (research.md R1, R2, R8):
  - Der `singleclick`-Handler ruft `addMeasurePoint` statt `nextMeasureState`.
  - `render()` baut alle Features neu auf: je Messung zwei Punkt-Features und ein LineString-Feature, alle mit der Property `measurementId`. Der offene Punkt A erhält keine.
  - Das Style-Callback liest nicht mehr den globalen `a`/`b`-Zustand. Es sucht die Messung über `measurementId` und beschriftet jede Linie mit ihrer eigenen Entfernung (`formatMeasuredKm(measureDistanceKm(a, b), intlLocale.value)`).
  - `deactivate()` ruft `discardPending` statt den Zustand zu leeren und rendert neu.
  - `distanceLabel` zeigt die Entfernung der zuletzt abgeschlossenen Messung (letzter Eintrag in `measurements`), sonst `null`.
  - Neu zurückgeben: `measurements` als `ComputedRef<{ id: number; label: string }[]>` mit fertig formatierter Entfernung und `remove(id)`, das `removeMeasurement` anwendet und neu rendert.
  - Die Rückgabe so bündeln, dass `DetailMap.client.vue` nicht wächst: `active`, `layer`, `toggle`, `remove` und ein `controlProps`-Computed `{ active, hint, distance, measurements }`, das der Elternteil per `v-bind` an das Control hängt (das ersetzt dort drei `:prop`-Zeilen).
  - Den Kommentar über dem Composable auf mehrere Messungen anpassen.
- [X] T005 [P] [US1] In `i18n/locales/de.json` und `i18n/locales/en.json` im Block `map`:
  - `measureHintStart` ändern (de: „Startpunkt in die Karte klicken, Esc beendet“, en: „Click the map to set the start point, Esc to exit“).
  - `measureHintRestart` in beiden Dateien löschen.
  - `measureHintEnd` bleibt.
- [X] T006 [US1] In `components/Auction/DetailMap.client.vue` die Verdrahtung auf die neue Rückgabe umstellen: die Destrukturierung von `useDetailMapDistanceMeasure` (`layer`, `active`, `controlProps`, `toggle`, `remove`) und an `<AuctionDetailMapMeasureControl>` `v-bind="measureControlProps"` statt der Einzel-Props `:active`, `:hint`, `:distance`. Datei muss ≤ 500 Zeilen bleiben (zuvor genau 500) und darf nicht wachsen.
- [X] T007 [US1] In `components/Auction/DetailMapMeasureControl.vue` die neue Prop `measurements: { id: number; label: string }[]` und das Event `remove: [id: number]` deklarieren, damit das `v-bind` aus T006 typkorrekt ist. Gerendert wird die Liste erst in T011.

**Checkpoint**: US1 nutzbar: mehrere Linien bleiben stehen, jede mit eigener Zahl. Löschen geht noch nicht.

---

## Phase 4: User Story 2 - Einzelne Messung entfernen (Priority: P2)

**Goal**: Beim Hover zeigt jede Linie einen schwebenden „X“-Button, der genau diese Messung entfernt. Auf Touch per Antippen, per Tastatur über eine verborgene Liste.

**Independent Test**: quickstart.md Schritte 4–8.

### Implementation for User Story 2

- [X] T008 [P] [US2] In `lib/distance-measure.ts` `removeButtonOffset(pixel: [number, number], size: [number, number], margin = 16): [number, number]` ergänzen (research.md R4). Standardversatz schräg unten rechts, `[14, 14]` (die Beschriftung steht oberhalb der Linie). Der jeweilige Anteil wird umgekehrt, wenn der Anker näher als `margin` plus Versatz am rechten bzw. unteren Rand liegt (die Kartengröße kommt als zweiter Parameter `size` = Breite/Höhe des Kartenausschnitts, `pixel` ist die Position des Ankers im Ausschnitt). Rein, ohne DOM.
- [X] T009 [US2] In `lib/distance-measure.test.ts` Tests für `removeButtonOffset` ergänzen: Mitte der Karte → Standardversatz; Anker am rechten Rand → x-Anteil umgekehrt; am oberen Rand → y-Anteil umgekehrt; in der Ecke beide; Ergebnis liegt in allen Fällen innerhalb des Ausschnitts.
- [X] T010 [US2] Den „X“-Button in einem eigenen Composable `composables/useDetailMapMeasureRemoveButton.ts` umsetzen und in `composables/useDetailMapDistanceMeasure.ts` einbinden (research.md R3, R5; contracts/detail-map-ui.md):
  - Beim Setzen von `map` ein `<button type="button">` per `document.createElement` bauen (Text „×“, `aria-label` = `t('map.measureRemove')`, Klassen im Stil der Kartenbuttons) und einen `ol/Overlay` mit `positioning: 'center-center'` und diesem Element der Karte hinzufügen. Beim Wechsel der Karte und bei `onScopeDispose` das Overlay entfernen, Listener lösen, Timer löschen.
  - `pointermove` (nicht bei `evt.dragging`): `forEachFeatureAtPixel` nur für die Messebene (`layerFilter`) mit `hitTolerance: 6`; Treffer mit `measurementId` setzen `hoveredId` und platzieren das Overlay am nächsten Punkt der Linie zum Zeiger (`getClosestPoint`, bei Punkt-Features dessen Koordinate), mit `removeButtonOffset(pixel, mapSize)`; solange derselbe Treffer gilt, wird die Position nicht nachgeführt.
  - Kein Treffer oder `pointerleave` des Viewports: Ausblenden mit 250 ms Verzögerung. `mouseenter` auf dem Button bricht das Ausblenden ab, `mouseleave` plant es wieder ein.
  - `singleclick`: Bei ausgeschaltetem Modus wählt ein Treffer auf eine Messung diese als `selectedId` (zeigt den Button), ein Klick daneben hebt die Auswahl auf. Bei aktivem Modus bleibt das Verhalten aus T004 (Klick setzt einen Messpunkt) und hebt die Auswahl auf.
  - Sichtbar ist der Button für `hoveredId ?? selectedId`. Ein Klick auf den Button ruft `remove(id)` und blendet ihn aus. Das Overlay verwendet das Standard-`stopEvent`, damit der Klick weder einen Messpunkt setzt noch ein Popup öffnet oder schließt (FR-011).
  - `remove` setzt `hoveredId` und `selectedId` zurück, wenn sie auf die entfernte Messung zeigten, und lässt `pending` unverändert (FR-012).
- [X] T011 [US2] In `components/Auction/DetailMapMeasureControl.vue` die Liste rendern (research.md R6): ein `<ul>` mit `:aria-label="t('map.measureListLabel')"`, `class="sr-only focus-within:not-sr-only …"`, nur wenn `measurements.length > 0`. Jeder Eintrag zeigt die Entfernung (`label`) und einen `<button type="button">` mit `aria-label` = `t('map.measureRemove')` plus der Entfernung. Klick löst `emit('remove', id)` aus. Dazu den Container so gestalten, dass die Liste unter dem Hinweis sichtbar wird, sobald sie Fokus hat.
- [X] T012 [P] [US2] In `i18n/locales/de.json` und `i18n/locales/en.json` im Block `map` ergänzen: `measureRemove` (de: „Messung entfernen“, en: „Remove measurement“) und `measureListLabel` (de: „Messungen“, en: „Measurements“).
- [X] T013 [US2] In `components/Auction/DetailMap.client.vue` `@remove="remove"` am `<AuctionDetailMapMeasureControl>` anschließen. Datei muss ≤ 500 Zeilen bleiben.

**Checkpoint**: US2 vollständig nutzbar.

---

## Phase 5: Polish & Cross-Cutting Concerns

- [X] T014 `pnpm test`, `pnpm typecheck` und `pnpm lint` ausführen und alle Fehler beheben. Size-Gate: `wc -l` aller geänderten Produktionsdateien muss jeweils ≤ 500 sein (`DetailMap.client.vue` darf nicht über 500 wachsen).
- [X] T015 Die Ersatz-Schnittstelle in `specs/007-detail-map-persistent-measurements/contracts/detail-map-ui.md` an das tatsächliche Composable-Rückgabeobjekt angleichen (`controlProps` statt Einzelfeldern), falls es abweicht.
- [X] T016 quickstart.md „Manuell“ durchspielen. Erledigt in Headless-Chromium über eine temporäre, nicht eingecheckte Demo-Seite mit der Detailkarte (Maus, Touch, Tastatur, Rand, Mess-Modus an/aus; 22 Prüfungen). Nicht gegen echte Auktionsdaten und nicht in anderen Browsern geprüft.
- [X] T017 `graphify update .` ausführen.
- [X] T018 Commits nach Conventional Commits anlegen (`docs(spec): …` für specs/, `feat(detail-map): …` je Story), ohne Agenten-Referenzen und ohne Co-Authored-By-Trailer. Push und PR gegen `main` (Merge per rebase oder merge-commit, nicht squash).

---

## Dependencies & Execution Order

- **Setup (T001)** → **Foundational (T002, T003)** → US1 → US2 → **Polish**.
- **US1**: T004 braucht T002. T005 ist parallel zu allem. T006 und T007 brauchen T004 (T007 vor T006, damit das `v-bind` typkorrekt ist).
- **US2** braucht US1 (die Rückgabe aus T004 und das Control aus T007):
  - T008 und T012 parallel zu T010 (andere Dateien beziehungsweise nur unabhängige Keys).
  - T009 braucht T008. T010 braucht T008. T011 braucht T007 und T012. T013 braucht T010 und T011.
- **Gemeinsame Dateien**: `lib/distance-measure.ts` (T002, T008), `lib/distance-measure.test.ts` (T003, T009), das Composable (T004, T010), das Control (T007, T011) und `DetailMap.client.vue` (T006, T013) laufen jeweils nacheinander.

## Parallel Example

```text
Foundational: T002 lib/distance-measure.ts → T003 lib/distance-measure.test.ts
US1: T004 Composable | T005 i18n (hint)
US2: T008 lib removeButtonOffset | T012 i18n (remove, list)
```

## Implementation Strategy

- **MVP**: Phase 1–3 (US1). Messungen bleiben stehen und lassen sich über Neuladen wieder loswerden.
- **Inkrement 2**: US2 (Entfernen), dann Polish.
- Beide Stories gehen in einen PR, als getrennte Commits je Story.
