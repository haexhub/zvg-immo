# Implementation Plan: Dauerhafte Entfernungsmessungen auf der Detailkarte

**Branch**: `007-detail-map-persistent-measurements` | **Date**: 2026-10-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/007-detail-map-persistent-measurements/spec.md`

## Summary

Der Mess-Modus aus Spec 006 hält bisher genau eine Messung. Dieses Feature
erweitert ihn so, dass abgeschlossene Messungen stehen bleiben, auch nach dem
Beenden des Modus und neben neuen. Jede Linie zeigt beim Hover einen schwebenden
„X“-Button, der genau diese Messung entfernt.

Technisch:
1. Der Zustand in `lib/distance-measure.ts` wird von einem Paar `a`/`b` zu einer Liste `Measurement[]` plus einem offenen Punkt.
2. Das Composable `useDetailMapDistanceMeasure` rendert alle Messungen und verwaltet einen `ol/Overlay` mit dem „X“-Button.
3. Das Control bekommt eine verborgene, per Tastatur erreichbare Liste zum Entfernen.

Keine neue Abhängigkeit, kein Server-Code, keine Persistenz.

## Technical Context

**Language/Version**: TypeScript (strict), Vue 3 `<script setup>` in Nuxt

**Primary Dependencies**: `ol` (schon installiert): `ol/Overlay`, `ol/geom` (`getClosestPoint`), `ol/layer/Vector`. Dazu Nuxt-i18n.

**Storage**: N/A, nur Zustand im Browser

**Testing**: Vitest (`environment: 'node'`, `pnpm test`). Die Zustandslogik und die Randlage des Buttons liegen als reine Funktionen in `lib/` und sind testbar. Die OL-Verdrahtung läuft nur im Browser und wird manuell geprüft (quickstart.md).

**Target Platform**: Browser, Desktop und Mobil (`.client.vue`)

**Project Type**: Web-App (Nuxt)

**Performance Goals**: 20 Messungen ohne spürbare Verzögerung bei Verschieben, Zoomen und Entfernen (SC-005)

**Constraints**:
- Produktionsdateien höchstens 500 Zeilen. `DetailMap.client.vue` steht bei **genau 500**. Die neue Logik darf sie nicht vergrößern und lebt deshalb in Composable und Control.
- Keine neue Abhängigkeit.

**Scale/Scope**:
- Geändert: `lib/distance-measure.ts` (+Test), `composables/useDetailMapDistanceMeasure.ts`, `components/Auction/DetailMapMeasureControl.vue`, `components/Auction/DetailMap.client.vue` (wenige Zeilen, netto ≤ 0), `i18n/locales/{de,en}.json`.
- Neu: keine Dateien außer den Spec-Artefakten.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Grundlage ist `.spaex/constitution.md`; `.specify/memory/constitution.md` ist nur ein unausgefülltes Template.

| Regel | Bewertung |
|---|---|
| Worktree und Topic-Branch, PR auf `main`, kein Squash | ✅ Worktree `.worktrees/007-detail-map-persistent-measurements`, Branch `007-detail-map-persistent-measurements` von aktuellem `main` |
| Graph konsultieren, Erweitern statt Duplizieren | ✅ `graphify query` zeigt `lib/distance-measure.ts` und `useDetailMapDistanceMeasure` als die einzigen Kandidaten. Beide werden **erweitert**, nichts Paralleles gebaut |
| Laziness ladder, keine neue Abhängigkeit | ✅ Alles mit `ol` und DOM. Kein UI-Kit-Button im Overlay, weil dort ein schlichtes `<button>` genügt |
| höchstens 500 LoC je Datei | ✅ `DetailMap.client.vue` bleibt bei ≤ 500 (siehe Constraints). Das Composable wächst von 127 auf rund 250 Zeilen |
| Tests getrennt, eine lauffähige Prüfung je nicht-trivialer Logik | ✅ `lib/distance-measure.test.ts` wird auf das neue Modell umgestellt und um `removeButtonOffset` ergänzt |
| Validierung an Vertrauensgrenzen | ✅ Keine neuen Eingaben von außen. Die Texte im Overlay kommen aus i18n, nie aus Nutzerdaten |
| Conventional Commits, keine Agenten-Referenzen, kein Co-Authored-By | ✅ |
| `ponytail:` für bewusste Vereinfachungen | ✅ Komplettes Neuaufbauen der Quelle bei jeder Änderung (research.md R9) |
| ADR bei Prinzip-berührenden Entscheidungen | ✅ Keine: reine UI-Änderung |

Ergebnis: **PASS**, keine Verstöße. Complexity Tracking entfällt.

## Project Structure

### Documentation (this feature)

```text
specs/007-detail-map-persistent-measurements/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/detail-map-ui.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
lib/
├── distance-measure.ts          # GEÄNDERT: Measurement/MeasureState, addMeasurePoint, removeMeasurement, discardPending, removeButtonOffset
└── distance-measure.test.ts     # GEÄNDERT

composables/
└── useDetailMapDistanceMeasure.ts  # GEÄNDERT: Mehrfach-Rendering, X-Overlay, Hover/Auswahl, remove

components/Auction/
├── DetailMapMeasureControl.vue  # GEÄNDERT: verborgene, fokussierbare Messungsliste
└── DetailMap.client.vue         # GEÄNDERT: neue Props/Events ans Control (netto ≤ 0 Zeilen)

i18n/locales/{de,en}.json        # GEÄNDERT: map.measureHintStart, measureHintRestart entfällt, measureRemove, measureListLabel neu
```

**Structure Decision**: Die Struktur aus 006 bleibt. Reine Logik in `lib/`, OL-Verdrahtung im Composable, Darstellung im Control. Das Overlay-Element entsteht im Composable und nicht im Template, damit die Detailkarte unter der 500-Zeilen-Grenze bleibt.

## Design-Entscheidungen im Detail

Begründungen und verworfene Alternativen: [research.md](./research.md). Kurzfassung:

- **Zustand** (R1): `{ measurements, pending, nextId }`, nur reine Funktionen. Beenden des Modus verwirft nur `pending`.
- **Rendering** (R2): Eine Ebene, Features mit `measurementId`, Beschriftung je Messung. Das 006-Callback las global `a`/`b` und müsste ohnehin geändert werden.
- **X-Button** (R3): Ein Overlay für alle. Er sitzt am nächsten Punkt der Linie zum Zeiger, erscheint bei `hitTolerance: 6` und bleibt 250 ms nach dem Verlassen, damit der Zeiger ihn erreicht.
- **Rand** (R4): `removeButtonOffset` kehrt den Versatz um, wenn der Anker am Rand liegt.
- **Touch** (R5): Hover nur für Maus. Auf Touch wählt ein Tipp auf die Linie bei **ausgeschaltetem** Modus die Messung aus. Im Modus gehören Klicks den Messpunkten. Wer per Touch löschen will, beendet den Modus erst.
- **Tastatur** (R6): Verborgene Liste mit Entfernen-Buttons, sichtbar bei Fokus.

## Offene Hinweise zur Prüfung

- Der Hover und das Positionieren des „X“ laufen nur in einem Browser. Das lässt sich ohne Datenbank mit Auktionen schwer vollständig prüfen. Deshalb ist die Logik so weit wie möglich in `lib/` ausgelagert, und quickstart.md beschreibt die manuellen Schritte.

## Complexity Tracking

Keine Verstöße, entfällt.
