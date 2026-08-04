# WP-8 — Lagebeschreibung und Nutzungsprofile

Datum: 2026-08-04
Teil von [GIS-Architektur](2026-08-04-gis-scaling-architecture.md). Abhängig von: [WP-5](2026-08-04-gis-wp5-precompute-suche.md), [WP-7](2026-08-04-gis-wp7-klima-grid.md).
Aufwand: 2–3 Tage. Repo: `zvg-immo`.

## Ziel

Aus den vorberechneten Zahlen eine ganzheitliche Lagebeschreibung machen — und zwar in zwei Lesarten, weil dieselbe Lage für Eigennutzung und wirtschaftliche Nutzung unterschiedlich zu bewerten ist.

Beispiel für dasselbe Objekt:

> **Freizeit & Tourismus: sehr gut** — Skigebiet 23 km (Vitosha), Badesee 1,8 km, Wanderwegnetz angrenzend, Angelmöglichkeit 2,4 km, 12 Sehenswürdigkeiten im Umkreis 30 km, 34 touristische Betriebe in 10 km
> **Klima:** Sommer max. Ø 27,4 °C, Winter Ø 1,2 °C, 118 Frosttage

Dieses WP schreibt **keine neuen Daten** — alle Eingangswerte liegen nach WP-5 und WP-7 in `auction_geo_metrics` und `climate_cells`. Es ist reine Aggregation und Darstellung.

## Warum erst zum Schluss

Ein Score über Rohdaten, die noch live berechnet werden, wäre pro Detailseite so teuer wie eine Suchanfrage. Erst wenn die Zahlen als Spalten vorliegen, ist die Lagebeschreibung ein Lesevorgang.

## Zwei Nutzungsprofile, ein Datensatz

Die Gewichtung unterscheidet sich, die Zahlen nicht:

| Kriterium | Eigennutzung | wirtschaftliche Nutzung |
|---|---|---|
| Nahversorgung, Schule, Ärzte | hoch | niedrig |
| Skigebiet, Badesee, Wanderwege | mittel | **hoch** (Vermietbarkeit) |
| touristische Betriebsdichte | niedrig | **hoch** (erschlossener Markt) |
| Sehenswürdigkeiten | niedrig | hoch |
| Flughafennähe | ambivalent (Lärm vs. Erreichbarkeit) | hoch |
| Verkehrslärm, Industrie | **negativ** | mittel |
| Sommertemperatur | Komfort | Saisonlänge |

Der Punkt: Flughafennähe ist für Eigennutzung ein Nachteil und für Ferienvermietung ein Vorteil. Ein einziger „Lage-Score" würde das mitteln und wäre für beide Zielgruppen falsch. Deshalb **zwei getrennte Ausgaben**, nie ein gemeinsamer Mittelwert.

## Wo es hingehört

Es existiert bereits eine Lagequalitäts-Auswertung: `locationContext` wird von [external-enrichment.ts](server/tasks/external-enrichment.ts) berechnet und in [DetailLocationSection.vue](components/Auction/DetailLocationSection.vue) angezeigt. Dieses WP ist deren natürliche Erweiterung, **kein Parallelsystem**.

Vor dem Bauen klären: Wird `locationContext` durch die neuen Metriken ersetzt oder ergänzt? Es enthält Dinge, die `auction_geo_metrics` nicht hat (Verkehrslärm, Industrienähe, Nahversorgung — aus den vorhandenen `CATEGORIES` in [osm-location-context.ts](server/utils/external-data/osm-location-context.ts)). Der sinnvolle Zuschnitt ist wahrscheinlich: `locationContext` behält Umfeld/Störfaktoren, die neuen Metriken liefern Freizeit/Tourismus/Klima, und die UI führt beides in einer Sektion zusammen. Diese Entscheidung ist der erste Schritt — nicht das Coden.

## Schritte

1. **Verhältnis zu `locationContext` entscheiden** und dokumentieren.
2. **Aggregationsfunktion** (rein, testbar, ohne DB-Zugriff): nimmt eine `auction_geo_metrics`-Zeile plus Klimawerte, gibt pro Profil eine Bewertung und die Begründungstexte zurück. Als eigenes Modul unter `server/utils/`, damit es unit-testbar ist.
3. **Schwellenwerte** je Kriterium festlegen (z. B. Skigebiet: < 15 km sehr gut, < 40 km gut, < 80 km mäßig). Diese Zahlen sind Produktentscheidungen, keine technischen — als benannte Konstanten an einer Stelle, nicht über den Code verstreut.
4. **i18n:** Alle Texte über die bestehenden Übersetzungsdateien. Das Projekt ist mehrsprachig; hartcodierte deutsche Strings fallen erst spät auf.
5. **UI** in der bestehenden Detail-Sektion, dem `DetailSectionCard`-Muster folgend.
6. **Optional:** die Profile als Sortierung in der Suche („beste Freizeitlage zuerst"). Erst nach WP-5, dann trivial.

## Verifikation

1. Unit-Tests der Aggregation mit konstruierten Eingaben: fehlende Werte, Cutoff-NULLs, Extremwerte.
2. **Der wichtigste Test:** ein Objekt, bei dem sich die beiden Profile *unterscheiden* müssen — etwa ein Haus direkt am Flughafen. Wenn beide Profile dasselbe sagen, ist die Gewichtung wirkungslos implementiert.
3. Drei echte Auktionen mit Koordinaten durchspielen und die Aussagen gegen die Karte prüfen. Nach WP-3 gibt es dafür genug geocodierte Objekte; heute wären es nur 37.
4. Auktion ohne Metrikzeile zeigt „keine Angaben", nicht „alles schlecht" — ein fehlender Wert darf keine negative Bewertung erzeugen.
5. Cutoff korrekt dargestellt: „> 200 km" statt „unbekannt" (siehe WP-5).
6. Alle Texte erscheinen in allen konfigurierten Sprachen.

## Fallstricke

- **Ein gemeinsamer Score** statt zwei Profilen — mittelt gegensätzliche Kriterien weg.
- **NULL als 0 behandeln** → „nichts in Reichweite" wird zu „Entfernung 0", also zur Bestbewertung. Das ist der gefährlichste Einzelfehler in diesem WP, weil das Ergebnis plausibel aussieht.
- **Score ohne Begründung** → nicht überprüfbar und für Nutzer nicht nachvollziehbar. Immer die Einzelwerte mit ausgeben, nicht nur das Urteil.
- **Daten schreiben, die niemand liest** — im Projekt schon passiert (`reportedNoise` wurde geschrieben, aber nie gelesen; PR #237). Umgekehrt gilt hier: nichts aggregieren, was die UI nicht zeigt.
- **Schwellenwerte im Code verstreut** → nicht nachjustierbar, ohne sie zu suchen.
- **Nicht in `locationContext` doppelt berechnen**, was `auction_geo_metrics` schon hat — sonst driften zwei Quellen für dieselbe Aussage auseinander.
