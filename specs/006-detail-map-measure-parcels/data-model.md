# Data Model: Entfernung messen und Flurstücke auf der Detailkarte

Nichts davon wird persistiert. Alle Typen leben nur im Browser während die
Detailkarte gemountet ist. Keine DB-, API- oder Migrationsänderung.

## MeasureState (Mess-Modus)

Reiner Zustand, unabhängig von OpenLayers; Koordinaten als `[lng, lat]` (WGS84).

| Feld | Typ | Bedeutung |
|---|---|---|
| `a` | `[number, number] \| null` | Startpunkt |
| `b` | `[number, number] \| null` | Endpunkt; nur gesetzt, wenn `a` gesetzt ist |

Abgeleitet: `distanceKm = b ? geodätische Distanz(a, b) : null`.

### Übergänge (`nextMeasureState(state, point)`)

| Vorher | Klick auf `p` | Nachher |
|---|---|---|
| `{a: null, b: null}` | p | `{a: p, b: null}` |
| `{a, b: null}` | p | `{a, b: p}` |
| `{a, b}` (fertig) | p | `{a: p, b: null}` (neue Messung, FR-005) |

Modus aus (Button / Esc) → Zustand wird auf `{a: null, b: null}` zurückgesetzt
und alle Messgrafiken entfernt (FR-006). Pan/Zoom erzeugen keinen Klick (OL
`click` feuert nur unterhalb `moveTolerance`), ändern den Zustand also nicht (FR-008).

### Hinweistext je Zustand

| Zustand | i18n-Key |
|---|---|
| aktiv, `a == null` | `map.measureHintStart` |
| aktiv, `a != null && b == null` | `map.measureHintEnd` |
| aktiv, `b != null` | `map.measureHintRestart` |

## CadastralParcelSource (Flurstücksquelle)

Statische, im Code gepflegte Tabelle (`lib/cadastral-parcels.ts`), ein
Eintrag je unterstütztem Gebiet.

| Feld | Typ | Bedeutung |
|---|---|---|
| `id` | `string` | Gebietsschlüssel (alle Dienste: WMS 1.3.0, fest in `cadastralParcelLayer`), `de-<bundesland-kürzel>` bzw. ISO-Ländercode (`fr`, `pl`, `cz`, `es`) |
| `url` | `string` | WMS-GetMap-Basis-URL |
| `layers` | `string` | WMS-`LAYERS`-Parameter (kommasepariert) |
| `styles` | `string?` | optional WMS-`STYLES` |
| `attribution` | `string` | Quellen-/Lizenzhinweis für die OL-Attribution (FR-015) |
| `minZoom` | `number` | Ab hier zeichnet der Dienst (aus seiner `MaxScaleDenominator`; ohne Grenze 15). Darunter ist der Layer ausgeblendet (FR-014) |
| `opacity` | `number?` | Deckkraft, Standard 1 (FR: 0.7) |

### Auswahl (`cadastralParcelSourceFor(country, region)`)

- `country === 'de'`: `bundeslandFromRegion(region)` (bestehend, `lib/auction-costs.ts`) → Eintrag des Bundeslands; unbekannte/leere Region oder Land ohne Dienst → `null`.
- `country ∈ {fr, pl, cz, es}` → nationaler Eintrag (Italien entfällt, siehe plan.md).
- sonst → `null` (FR-012: kein Layer-Eintrag).
