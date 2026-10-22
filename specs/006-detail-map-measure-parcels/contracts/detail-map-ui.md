# UI Contract: Detailkarte (Messen & Flurstücke)

Keine HTTP-API-Änderung. Der Vertrag betrifft die Komponenten- und Modulschnittstellen,
die die Umsetzung festlegt.

## `AuctionDetailMap` (components/Auction/DetailMap.client.vue)

Neue optionale Props (bestehende bleiben unverändert):

| Prop | Typ | Quelle (DetailLocationSection) |
|---|---|---|
| `country` | `string \| undefined` | `auction.country` (ISO alpha-2, klein) |
| `region` | `string \| undefined` | `auction.region` (Name, z. B. `Sachsen`; leer erlaubt) |

Fehlen beide Props, verhält sich die Karte wie heute und zeigt keinen Flurstücks-Eintrag.

## `AuctionDetailMapMeasureControl` (components/Auction/DetailMapMeasureControl.vue)

| Prop/Event | Typ | Bedeutung |
|---|---|---|
| `active` | `boolean` | Modus an/aus → `aria-pressed` |
| `hint` | `string \| null` | Angezeigter Hinweis (nur wenn aktiv) |
| `toggleClass` | `string` | Gleiche Optik wie die übrigen Kartenbuttons |
| `@toggle` | `()` | Klick auf den Button |

Der Button ist ein `<button type="button">` mit sichtbarem Text `t('map.measureDistance')`
und `aria-pressed`. Der Hinweis liegt in einem `aria-live="polite"`-Element.

## `lib/distance-measure.ts`

```ts
type LngLat = [number, number]
interface MeasureState { a: LngLat | null; b: LngLat | null }
const EMPTY_MEASURE: MeasureState
function nextMeasureState(state: MeasureState, point: LngLat): MeasureState
function measureDistanceKm(a: LngLat, b: LngLat): number          // geodätisch
function formatMeasuredKm(km: number, locale: string): string      // nur Zahl, ohne Einheit
```

## `lib/cadastral-parcels.ts`

```ts
interface CadastralParcelSource {
  id: string; url: string; layers: string; minZoom: number
  attribution: string; opacity?: number; styles?: string
}
function cadastralParcelSourceFor(country?: string | null, region?: string | null): CadastralParcelSource | null
function cadastralParcelLayer(source: CadastralParcelSource): ImageLayer<ImageWMS>
```

Invarianten:
- `cadastralParcelLayer` setzt nie `crossOrigin`.
- `cadastralParcelLayer` fordert immer `VERSION=1.3.0`, `CRS=EPSG:3857`, `FORMAT=image/png` und `TRANSPARENT=TRUE` an.
- Die Layer-`minZoom` ist `source.minZoom`.
