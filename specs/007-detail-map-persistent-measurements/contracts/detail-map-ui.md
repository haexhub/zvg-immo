# UI Contract: Dauerhafte Messungen

Keine HTTP-API-Änderung. Fortschreibung von
`specs/006-detail-map-measure-parcels/contracts/detail-map-ui.md`.

## `lib/distance-measure.ts`

```ts
type LngLat = [number, number]
interface Measurement { id: number; a: LngLat; b: LngLat }
interface MeasureState { measurements: Measurement[]; pending: LngLat | null; nextId: number }
const EMPTY_MEASURE: MeasureState

function addMeasurePoint(state: MeasureState, point: LngLat): MeasureState
function removeMeasurement(state: MeasureState, id: number): MeasureState
function discardPending(state: MeasureState): MeasureState
function measureHintKey(active: boolean, state: MeasureState): string | null
function removeButtonOffset(pixel: [number, number], size: [number, number], margin?: number): [number, number]

// unverändert aus 006
function measureDistanceKm(a: LngLat, b: LngLat): number
function formatMeasuredKm(km: number, locale: string): string
```

Entfällt: `nextMeasureState` (ersetzt durch `addMeasurePoint`).

Invarianten:
- Alle Funktionen sind rein und geben einen neuen Zustand zurück.
- `removeMeasurement` mit unbekannter `id` gibt den Zustand unverändert zurück.
- `removeButtonOffset` liefert einen Versatz, bei dem der Button samt `size` innerhalb des Kartenausschnitts bleibt, sobald dieser mindestens `size` plus `margin` je Seite misst.

## `useDetailMapDistanceMeasure({ map })`

Rückgabe (Erweiterung der 006-Schnittstelle):

| Feld | Typ | Bedeutung |
|---|---|---|
| `layer` | `VectorLayer` | wie 006 |
| `active` | `Ref<boolean>` | Mess-Modus |
| `hint` | `ComputedRef<string \| null>` | wie 006, siehe `measureHintKey` |
| `distanceLabel` | `ComputedRef<string \| null>` | Entfernung der zuletzt abgeschlossenen Messung |
| `measurements` | `ComputedRef<{ id: number; label: string }[]>` | Messungen mit fertig formatierter Entfernung, für die Liste im Control |
| `toggle` | `() => void` | Modus an/aus |
| `remove` | `(id: number) => void` | Messung entfernen |

Verhalten:
- Das Composable legt den Overlay mit dem „X“-Button selbst an der Karte an und räumt ihn bei `onScopeDispose` wieder auf.
- Der „X“-Button ist ein `<button type="button">` mit `aria-label` = `t('map.measureRemove')`.
- Ein Klick auf den Button ruft `remove(id)` und erreicht weder den Messpunkt-Handler noch den Popup-Handler (Overlay `stopEvent`).

## `AuctionDetailMapMeasureControl`

Zusätzliche Props zu 006 (`active`, `hint`, `distance`, `toggleClass`):

| Prop/Event | Typ | Bedeutung |
|---|---|---|
| `measurements` | `{ id: number; label: string }[]` | Einträge der verborgenen Liste |
| `@remove` | `(id: number)` | Entfernen-Button eines Eintrags |

Die Liste ist ein `<ul>` mit `aria-label` = `t('map.measureListLabel')`. Sie ist per `sr-only` verborgen und mit `focus-within:not-sr-only` sichtbar, solange ein Element darin den Fokus hat. Jeder Eintrag enthält einen `<button type="button">` mit `aria-label` = „Messung entfernen“ plus der Entfernung.

## i18n

| Key | de | en |
|---|---|---|
| `map.measureHintStart` (geändert) | Startpunkt in die Karte klicken, Esc beendet | Click the map to set the start point, Esc to exit |
| `map.measureHintRestart` | entfällt | entfällt |
| `map.measureRemove` (neu) | Messung entfernen | Remove measurement |
| `map.measureListLabel` (neu) | Messungen | Measurements |
