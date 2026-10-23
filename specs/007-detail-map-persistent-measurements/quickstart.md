# Quickstart: Validierung

## Voraussetzungen

- Worktree `.worktrees/007-detail-map-persistent-measurements`, Abhängigkeiten installiert (`pnpm install --frozen-lockfile`), alles innerhalb der Nix-Shell (`nix develop`)
- Laufende Dev-Instanz (`pnpm dev`) mit einer Auktion mit Koordinaten

## Automatisch

```sh
pnpm test lib/distance-measure.test.ts
pnpm typecheck
pnpm lint
```

Erwartet:
- `addMeasurePoint` legt nach zwei Punkten eine Messung an und lässt frühere bestehen.
- `removeMeasurement` entfernt nur die gemeinte, auch bei gleicher Entfernung zweier Messungen.
- `discardPending` verwirft nur Punkt A.
- `removeButtonOffset` hält den Button auch am rechten und oberen Rand im Ausschnitt.

## Manuell (Browser)

Auf `/objekt/<platform>/<id>`:

1. **Mehrere Messungen**: „Entfernung messen“, Messung 1 (zwei Klicks), Messung 2 (zwei Klicks): beide Linien sichtbar, jede mit eigener km-Angabe.
2. **Modus beenden**: Esc oder Button → beide Linien bleiben, auch nach Zoomen, Verschieben und Wechsel Straße ↔ Satellit.
3. **Angefangene Messung**: Modus an, nur Punkt A setzen, Esc → Punkt A weg, fertige Linien bleiben.
4. **Entfernen per Maus**: Zeiger auf Linie 1 → „X“ erscheint nur dort. Zeiger zum „X“ bewegen (er bleibt sichtbar), klicken → nur Linie 1 weg. Zeiger weg von Linie und Button → „X“ verschwindet.
5. **X im Modus**: Modus an, Punkt A setzen, bei einer fertigen Linie „X“ klicken → nur diese weg, Punkt A bleibt, kein Messpunkt, kein Popup.
6. **Touch** (Geräte-Emulation im Browser): Modus aus, Linie antippen → „X“; Tipp auf „X“ entfernt; Tipp daneben blendet aus.
7. **Tastatur**: Tab bis zur Messungsliste, Entfernen-Button per Enter auslösen. Die Liste erscheint beim Fokussieren.
8. **Kartenrand**: Eine Linie so verschieben (Karte ziehen), dass sie am rechten Rand liegt, Zeiger darauf → „X“ liegt vollständig im Ausschnitt.
9. **Neuladen** → alle Messungen weg.
