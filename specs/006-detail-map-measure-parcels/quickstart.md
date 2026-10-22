# Quickstart: Validierung

## Voraussetzungen

- Worktree `.worktrees/006-detail-map-measure-parcels`, Abhängigkeiten installiert (`pnpm install --frozen-lockfile`)
- Laufende Dev-Instanz (`pnpm dev`) mit Zugriff auf eine DB, in der Auktionen mit Koordinaten aus DE, FR, PL, CZ und ES liegen

## Automatisch

```sh
pnpm test lib/distance-measure.test.ts lib/cadastral-parcels.test.ts
pnpm typecheck
pnpm lint
```

Erwartet:
- Distanz Berlin (13.405, 52.52) → München (11.582, 48.135) ≈ 504 km (±0,5 %).
- Gleicher Punkt → 0.
- `nextMeasureState` durchläuft leer → A → A+B → neues A.
- `cadastralParcelSourceFor('de', 'Sachsen')` liefert SN.
- `('es', '')` liefert ES.
- `('de', '')`, `('at', …)` und `('it', …)` liefern `null`.

## Manuell (Browser)

Auf `/objekt/<platform>/<id>` einer deutschen Auktion:

1. **Messen**:
   - „Entfernung messen" → Hinweis „Startpunkt setzen".
   - Klick → Punkt A. Klick → Linie und „x,xx km".
   - Dritter Klick → neue Messung.
   - Esc → alles weg.
   - Klick auf einen POI-Marker im Modus → kein Popup.
   - Ziehen der Karte → kein Punkt.
   - Doppelklick → zoomt, setzt aber nicht A und B auf denselben Punkt.
2. **Flurstücke**:
   - Layer-Panel → „Flurstücke" ist vorhanden und aus.
   - Einschalten → die Karte zoomt heran, Grenzen erscheinen, die Attribution nennt die Landesvermessung.
   - Herauszoomen unter die Mindeststufe → der Layer verschwindet.
   - Im Netzwerk-Tab gibt es vor dem Einschalten keine Anfragen an den WMS-Host.
3. **Negativfall**: Auf der Detailseite einer österreichischen oder italienischen Auktion fehlt der Eintrag „Flurstücke".
4. **Stichprobe SC-003**: je Gebiet aus research.md R7 mit ✅ eine Auktion öffnen und die Grenzen am Standort prüfen.
