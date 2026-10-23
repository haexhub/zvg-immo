# Research: Dauerhafte Entfernungsmessungen auf der Detailkarte

Aufbauend auf `specs/006-detail-map-measure-parcels/research.md` (R1 Distanz, R2
`singleclick`, R3 Darstellung). Hier nur, was sich ändert oder neu ist.

## R1 Zustandsmodell

- **Decision**: `MeasureState` wird zu `{ measurements: Measurement[], pending: LngLat | null, nextId: number }`. Eine `Measurement` ist `{ id, a, b }`. Die Übergänge bleiben reine Funktionen in `lib/distance-measure.ts`:
  - `addMeasurePoint(state, point)`: ohne `pending` wird der Punkt zu `pending`, sonst entsteht eine neue `Measurement` und `pending` wird leer.
  - `removeMeasurement(state, id)` entfernt genau eine, `pending` bleibt unberührt (FR-012).
  - `discardPending(state)` beim Beenden des Modus (FR-003).
- **Rationale**: Die stabile `id` macht „genau diese Messung entfernen“ eindeutig, auch wenn Beschriftungen gleich sind. Die Logik bleibt ohne OpenLayers testbar (Vitest läuft in `node`).
- **Alternatives considered**:
  - Index im Array als Identität bricht beim Entfernen einer früheren Messung.
  - Der Zustand im OL-Source (Features als Quelle der Wahrheit) macht die Logik untestbar und das Entfernen vom Rendern abhängig.

## R2 Rendering je Messung

- **Decision**: Die Vektorebene aus 006 bleibt. Jede Messung erzeugt zwei Punkt-Features und ein Linien-Feature, alle mit der Property `measurementId`. Das Style-Callback liest nicht mehr den globalen `a`/`b`-Zustand, sondern sucht die Messung über `measurementId` und beschriftet jede Linie mit ihrer eigenen Entfernung. Der noch offene Punkt A trägt keine `measurementId`.
- **Rationale**: Das 006-Callback las `state.value.a/b` für jede Linie. Bei mehreren Linien würden alle dieselbe Zahl zeigen. Die Property-Suche behebt das ohne Umbau der Ebene.
- **Alternatives considered**:
  - Ein Layer je Messung bringt Layer-Verwaltung und Z-Order-Probleme mit.

## R3 Der schwebende „X“-Button

- **Decision**: Ein einziger `ol/Overlay` mit einem echten `<button type="button">`, das beim Hover auf die jeweils getroffene Messung versetzt wird. Er wird im Composable per `document.createElement` gebaut, mit `aria-label` aus `t('map.measureRemove')`.
  - Treffer: `pointermove` mit `forEachFeatureAtPixel` nur auf der Messebene, `hitTolerance: 6`. Beim Treffer wird `hoveredId` gesetzt und der Button am nächsten Punkt der Linie zum Zeiger platziert (`getClosestPoint`), danach nicht mehr mitgeführt, solange derselbe Treffer gilt. So bleibt er erreichbar.
  - Verlassen: Der Button verschwindet nach 250 ms Verzögerung, wenn weder Linie noch Button überfahren werden. `mouseenter` auf dem Button bricht das Ausblenden ab. Die Verzögerung überbrückt die Lücke zwischen Linie und Button.
  - Der Viewport-Event `pointerleave` plant das Ausblenden ebenfalls ein.
  - **Wichtig (im Browser gefunden):** OpenLayers 10 leitet `pointermove` auch von über Overlay-Elementen weiter und fängt dort nur `pointerdown` ab. Ohne Gegenmaßnahme wertet der Hover-Handler den Zeiger auf dem Button als „nicht auf der Linie“ und blendet ihn aus. Bewegungen, deren Ziel der Button ist, werden deshalb ignoriert.
  - Bei überlappenden Linien trifft `forEachFeatureAtPixel` das zuoberst gezeichnete Feature, also die zuletzt angelegte Messung (Edge Case der Spec).
- **Rationale**: Ein Overlay-Element ist ein normaler DOM-Knoten: fokussierbar, beschriftbar, und `stopEvent` (Standard) hält Klicks auf ihm von den Karten-Handlern fern. Das erfüllt FR-011 ohne Zusatzcode: kein Messpunkt, kein Popup.
  - Der Aufbau in einem eigenen Composable (`useDetailMapMeasureRemoveButton`) statt im Template hält `DetailMap.client.vue` unter 500 Zeilen (CI-Size-Gate) und trennt Hover-Logik von der Messlogik.
- **Alternatives considered**:
  - Ein „X“ als Canvas-Icon im Style funktioniert nicht für Hover-Klicks, denn Canvas-Features haben keine Button-Semantik und keinen Fokus.
  - Ein Overlay je Messung erzeugt bei vielen Messungen unnötig viele DOM-Knoten.
  - Den Button an der Linienmitte fixieren: Bei langen Linien kann die Mitte außerhalb des Ausschnitts liegen (Edge Case Linie am Kartenrand).

## R4 Lage am Kartenrand

- **Decision**: Die reine Funktion `removeButtonOffset(pixel, size, margin)` in `lib/distance-measure.ts` wählt den Versatz des Buttons (Standard: schräg unten rechts, weil die Entfernungsbeschriftung oberhalb der Linie steht und sonst verdeckt würde) und kehrt ihn um, wenn der Anker näher als `margin` (halbe Buttongröße plus Abstand, Standard 16 px) an einem Rand liegt. So liegt der Button vollständig im sichtbaren Bereich.
- **Rationale**: Testbar ohne Browser. `Overlay.autoPan` würde die Karte verschieben, während die Person gerade zeigt, und das wäre irritierend.
- **Alternatives considered**: `autoPan`, siehe oben.

## R5 Touch

- **Decision**: Hover wird nur für Maus-Zeiger genutzt (`pointermove` ohne `dragging`). Auf Touch blendet `singleclick` auf einer Messung bei **ausgeschaltetem** Mess-Modus den Button ein (`selectedId`), ein `singleclick` anderswo blendet ihn aus. Sichtbar ist `hoveredId ?? selectedId`.
- **Rationale**: Im Mess-Modus gehören Klicks den Messpunkten (FR-013). Wer per Touch eine Messung löschen will, beendet den Modus erst (ein Tipp auf den Button). Mit Maus geht das Löschen jederzeit.
- **Alternatives considered**:
  - Im Modus ein Antippen der Linie als Auswahl zu werten, nimmt der Person die Möglichkeit, einen Messpunkt nahe einer bestehenden Linie zu setzen.

## R6 Tastatur und Screenreader (FR-010)

- **Decision**: Eine Liste im `DetailMapMeasureControl` mit je einem Eintrag und Entfernen-Button je Messung („3,2 km, Messung entfernen“). Sie ist per `sr-only` verborgen und mit `focus-within:not-sr-only` sichtbar, sobald ein Element darin den Fokus hat. Sie ist ein Tabstopp nach dem „Entfernung messen“-Button.
- **Rationale**: Ein Button, der nur beim Hover existiert, ist für Tastaturnutzer unerreichbar. Die verborgene Liste kostet im Normalfall keinen Platz auf der Karte und schließt die Lücke.
- **Alternatives considered**: Eine sichtbare Chip-Liste: dauerhaft Platz auf der Karte, vom Auftrag nicht verlangt.

## R7 Hinweistexte

- **Decision**: `map.measureHintRestart` entfällt, denn nach einer fertigen Messung ist der nächste Klick wieder „Startpunkt“. `map.measureHintStart` nennt Esc („Startpunkt in die Karte klicken. Esc beendet.“). Neu: `map.measureRemove` („Messung entfernen“) und `map.measureListLabel` („Messungen“).
- **Rationale**: Den „Restart“-Zustand gibt es im neuen Modell nicht.

## R8 Entfernungsansage (FR-006)

- **Decision**: `distanceLabel` aus 006 zeigt die Entfernung der **zuletzt abgeschlossenen** Messung (letzter Eintrag in `measurements`) im `aria-live`-Bereich, solange der Modus an ist.
- **Rationale**: Bisher las sie den globalen `a`/`b`-Zustand. Dieselbe Stelle, nur eine andere Quelle.

## R9 Leistung

- **Decision**: Nach jeder Änderung wird die Quelle komplett neu aufgebaut (`clear` + `addFeatures`), wie in 006. Der Treffertest läuft bei `pointermove` ohne weitere Drosselung.
- **Rationale**: Bei bis zu 20 Messungen (SC-005) sind das 60 Features. Ein inkrementelles Update wäre mehr Code ohne messbaren Gewinn.
  - `ponytail:` Ab einigen hundert Messungen müsste das Neuaufbauen durch gezieltes Hinzufügen/Entfernen ersetzt werden. Das ist hier unrealistisch.
