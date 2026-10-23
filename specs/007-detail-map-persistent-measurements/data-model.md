# Data Model: Dauerhafte Entfernungsmessungen

Nichts davon wird persistiert. Alle Typen leben im Browser, solange die
Detailkarte gemountet ist. Keine DB-, API- oder Migrationsänderung.

## Measurement

| Feld | Typ | Bedeutung |
|---|---|---|
| `id` | `number` | Stabile Identität, vergeben aus `MeasureState.nextId`, nie wiederverwendet |
| `a` | `[lng, lat]` | Startpunkt (WGS84) |
| `b` | `[lng, lat]` | Endpunkt (WGS84) |

Die Entfernung wird nicht gespeichert, sondern bei Bedarf aus `a` und `b` berechnet
(`measureDistanceKm`): Das hält Beschriftung und Zustand in Einklang.

## MeasureState

| Feld | Typ | Bedeutung |
|---|---|---|
| `measurements` | `Measurement[]` | Abgeschlossene Messungen in Anlegereihenfolge (letzte = zuoberst) |
| `pending` | `[lng, lat] \| null` | Punkt A der laufenden Messung |
| `nextId` | `number` | Zähler für die nächste `Measurement.id` |

Anfangszustand `EMPTY_MEASURE`: `{ measurements: [], pending: null, nextId: 1 }`.
Der Zustand wird nie verändert, jede Funktion liefert einen neuen.

### Übergänge

| Funktion | Vorher | Nachher |
|---|---|---|
| `addMeasurePoint(s, p)` | `pending == null` | `pending = p` |
| `addMeasurePoint(s, p)` | `pending != null` | `measurements += {id: nextId, a: pending, b: p}`, `pending = null`, `nextId + 1` |
| `removeMeasurement(s, id)` | beliebig | Messung mit `id` entfernt, alles andere gleich; unbekannte `id` → unverändert |
| `discardPending(s)` | beliebig | `pending = null`, `measurements` gleich |

Ein Modus-Aus (Button oder Esc) ruft `discardPending` auf und lässt `measurements`
stehen (FR-003). Ein Klick auf „X“ ruft `removeMeasurement` (FR-008, FR-012). Pan
und Zoom erzeugen keinen Klick und ändern den Zustand nicht.

### Hinweistext (`measureHintKey(active, state)`)

| Zustand | Key |
|---|---|
| Modus aus | `null` |
| aktiv, `pending == null` | `map.measureHintStart` |
| aktiv, `pending != null` | `map.measureHintEnd` |

## Hover-/Auswahlzustand (nur im Composable, nicht in `lib/`)

| Feld | Typ | Bedeutung |
|---|---|---|
| `hoveredId` | `number \| null` | Messung unter dem Mauszeiger |
| `selectedId` | `number \| null` | Per Antippen ausgewählte Messung (Touch, nur Modus aus) |

Sichtbar ist der „X“-Button für `hoveredId ?? selectedId`. Beim Entfernen einer Messung
werden beide auf `null` gesetzt, wenn sie auf sie zeigten.
