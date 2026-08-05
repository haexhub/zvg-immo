# WP-5 — `auction_geo_metrics` und Umstellung der Suche

Datum: 2026-08-04
Teil von [GIS-Architektur](2026-08-04-gis-scaling-architecture.md). Abhängig von: [WP-4](2026-08-04-gis-wp4-geo-features.md).
Aufwand: 3–4 Tage. Repo: `zvg-immo`. **Das ist der eigentliche Fix.**

> **Status 2026-08-06: implementiert** (`server/tasks/build-auction-geo-metrics.ts`, Umstellung in `server/utils/auction-search-filters.ts` + `server/api/landing/rails.get.ts`). Migriert: nearSea/nearLake/nearRiver/nearMountain/nearAirport, plus neu nearSki (die Spalte gab es schon als "erste Erweiterung" im Skeleton-Schema). Alle vier Landing-Rails (sea/mountains/lakes/rivers) laufen jetzt über `auction_geo_metrics` statt live gegen `osm_local_elements`.
>
> **Bewusst zurückgestellt:** `urbanRural` bleibt auf dem alten Live-Pfad (`osm-proximity.ts`, `proximityConditionAnyOf`) — ein `dist_city_m` bräuchte eine neue `city`/`place`-`kind` in WP-4s Kind-Tabelle, die dessen Statusvermerk als vollständig markiert; das ist eine eigene, größere Änderung, kein Nebenprodukt dieses WPs. `tourism_density_count` wird vom Precompute-Job berechnet (bleibt heute 0, da `tourism_supply` erst mit WP-6 befüllt wird), ist aber noch nicht als Suchfilter verdrahtet — stand nicht im "Umstellung der Suche"-Abschnitt unten.
>
> **Noch nicht gegen echte Prod-Daten gelaufen:** hängt an WP-4s erstem echten Lauf gegen den vollständigen OSM-Reimport (SE steht noch aus, siehe [WP-6](2026-08-04-gis-wp6-osm-datenausbau.md)) — mit `EXPLAIN` lokal (Docker-Sandbox mit `supabase/postgres`-Image) verifiziert, dass der migrierte Plan kein `osm_local_elements` und keine Geometriefunktion mehr enthält.
>
> Ein offener Punkt aus dem WP-4-Review, den dieses WP übernimmt: der Epoch-Lesevertrag, hier konkret festgelegt statt nur als Optionen skizziert.
>
> - **Vollständig heißt:** eine neue Tabelle `geo_features_epochs` (`epoch bigint PRIMARY KEY, completed_at timestamptz NOT NULL`) bekommt genau eine Zeile pro Epoch — geschrieben von `build-geo-features.ts` erst *nach* dem finalen `DELETE FROM geo_features WHERE features_epoch < epoch`. Vor diesem Zeitpunkt existiert die Epoch für Leser nicht.
> - **Leser und Precompute lesen ausschließlich die neueste vollständige Epoch:** `SELECT MAX(epoch) FROM geo_features_epochs`, nie `MAX(features_epoch) FROM geo_features` direkt — Letzteres würde während eines laufenden Aufbaus die gerade entstehende, partielle Epoch treffen.
> - **Abbruch und Wiederholung:** eine abgebrochene Epoch bekommt nie eine `geo_features_epochs`-Zeile und bleibt damit für Leser dauerhaft unsichtbar. Ihre Zeilen bleiben als Datenmüll in `geo_features` liegen, bis der nächste *erfolgreiche* Lauf sie über `WHERE features_epoch < epoch` mitlöscht (Epochs sind streng monoton steigend, das schließt übersprungene Epochs ein). Ein Retry ist damit einfach der nächste reguläre Lauf, kein Sonderfall.
> - **Ohne vollständige Epoch wird nichts gelesen:** eine leere `geo_features_epochs`-Tabelle liefert `MAX(epoch) = NULL`; Precompute schreibt dann keine Zeile für die betroffene Auktion/Kategorie. Gleiche Semantik wie im Datenmodell unten definiert („fehlende Zeile = nie berechnet") — kein Fallback auf eine unvollständige Epoch.
>
> Zwei weitere WP-4-Randbedingungen, die dieser Job wiederverwenden sollte statt neu zu erfinden: ein eigener Postgres-Pool mit hartem Connection-Limit für Off-Peak-Batch-Läufe (Lektion aus dem Prod-Totalausfall vom 2026-08-03), und ein Session-Advisory-Lock über den gesamten Lauf — `runExclusiveTask` serialisiert nur innerhalb eines Node-Prozesses, zwei Container liefen sonst gegeneinander.

## Warum

Heute liegt Geometrie im Anfragepfad. Der `EXPLAIN` der `nearSea`-Suche über alle Länder:

```
Nested Loop Semi Join  (cost=1000.28..42278575366.78 rows=4)
  Join Filter: st_dwithin((o.geom)::geography, st_makepoint(d.lng, d.lat)::geography, 5000)
  ->  Materialize  (rows=452035)
        ->  Parallel Seq Scan on osm_local_elements o
```

42,3 Milliarden Kosteneinheiten; `ST_DWithin` läuft als Join-Filter über 452 035 Zeilen — pro Auktion. Gemessen: 16 585 ms für einen einzelnen Punkt.

WP-1 macht daraus ~560 ms, aber das bleibt ein Pflaster: die Kosten wachsen weiter linear mit jeder geocodierten Auktion (heute 37, mit Adresse vorhanden 2 785, europaweit später sechsstellig) und mit jeder neuen Kategorie.

Nach diesem WP ist die Suche ein numerischer Zeilenfilter, und die Geometriearbeit passiert einmal nachts.

## Der Kerngedanke

Die vorberechnete **Distanz** (nicht ein Boolean) beantwortet *jeden* Radius, den der Nutzer wählt: `dist_sea_m <= 5000`. Deshalb braucht es keinen Live-Fallback für ungewöhnliche Radien — genau daran scheitert der heutige Ansatz, der pro Radius neu rechnet. Und dieselbe Zahl ist es, die die Lagebeschreibung („nächstes Skigebiet 23 km") ohnehin braucht.

## Datenmodell

```sql
CREATE TABLE auction_geo_metrics (
  platform     text NOT NULL,
  external_id  text NOT NULL,
  dist_sea_m        int,  dist_lake_m       int,  dist_river_m    int,
  dist_peak_m       int,  dist_airport_m    int,  dist_ski_m      int,
  dist_swimming_m   int,  dist_marina_m     int,  dist_hiking_m   int,
  dist_mtb_m        int,  dist_paddling_m   int,  dist_fishing_m  int,
  dist_attraction_m int,
  -- Dichte, nicht Distanz: misst, ob eine Gegend touristisch erschlossen IST
  tourism_supply_count_10km int,
  -- Namen für die Lagebeschreibung (WP-8)
  nearest_ski_name  text, nearest_lake_name text, nearest_attraction_name text,
  climate_cell_id   int,          -- FK erst mit WP-7
  computed_at    timestamptz NOT NULL DEFAULT now(),
  features_epoch int  NOT NULL,   -- Invalidierung bei OSM-Reimport (aus WP-4)
  point_hash     text NOT NULL,   -- Invalidierung bei Neu-Geocoding
  PRIMARY KEY (platform, external_id)
);
```

Als Drizzle-Schema, Migration via [WP-0](2026-08-04-gis-wp0-schema-neuaufbau.md). RLS wie bei allen Tabellen aktivieren (Drizzle generiert das nicht selbst).

> **Umgesetzt heißt die Spalte anders:** WP-0 hat `dist_mountain_m` (nicht `dist_peak_m`) und `tourism_density_count` (nicht `tourism_supply_count_10km`) angelegt, und nur die sechs Distanzspalten Meer/See/Fluss/Berg/Flughafen/Ski. Der Block oben ist der ursprüngliche Vorschlag; maßgeblich ist [schema/geo.ts](server/db/schema/geo.ts).

**Eine breite Zeile, nicht `(auktion, kind, distanz)`.** Die Suche verknüpft mit AND: `dist_sea_m <= 5000 AND dist_ski_m <= 50000` ist ein Zeilenfilter statt zweier Semi-Joins mit Aggregation. Sortierung („nächste am Meer zuerst") wird trivial, neue Kategorien sind ein additives `ADD COLUMN`.

**Warum das schnell ist, hat nichts mit Indizes zu tun.** ~20 `int`-Spalten sind ~100 Byte pro Auktion — heute 370 KB, bei einer Million Auktionen 100 MB, vollständig im Page-Cache. Ein Seq Scan darüber mit beliebig vielen numerischen Prädikaten kostet Millisekunden. Der Gewinn kommt daher, dass **zur Query-Zeit keine Geometrie mehr angefasst wird.** Zusätzliche B-Tree-Indizes erst anlegen, wenn eine Messung sie fordert — bei mehreren unabhängigen Range-Prädikaten nutzt Postgres ohnehin nur einen.

**NULL-Semantik, explizit.** Fehlende Zeile = nie berechnet. Vorhandene Zeile mit `dist_ski_m IS NULL` = nichts innerhalb Cutoff. Diese Unterscheidung ist bei `locationContext: null` schon einmal verloren gegangen ([osm-location-context.ts:141-145](server/utils/external-data/osm-location-context.ts#L141-L145)) und muss von Anfang an im Schema stehen, nicht nachträglich.

## Precompute-Job

Pro Auktion und Kategorie:

```sql
SELECT f.name, ST_Distance(f.geom_3035, $point) AS dist_m
FROM geo_features f
WHERE f.kind = $kind
  AND ST_DWithin(f.geom_3035, $point, $cutoff_m)
ORDER BY f.geom_3035 <-> $point
LIMIT 1;
```

`$point` ist die Auktionsposition, transformiert nach 3035. Cutoff je Kategorie (Vorschlag: Meer/Ski 200 km, See/Fluss/Berg 50 km, Freizeit/Sehenswürdigkeiten 30 km) — „nächstes Skigebiet 1 400 km" hat keinen Informationswert und zieht den KNN-Suchraum unnötig auf.

**Die Cutoffs sind gleichzeitig die Obergrenze der suchbaren Radien** und müssen deshalb an einer Stelle liegen, die dieser Job *und* die Filter-Validierung liest. Ein `NULL` heißt „weiter als der Cutoff", nicht „unbekannt" — fragt der Nutzer nach 300 km bei einem Cutoff von 200 km, sind die Treffer zwischen 200 und 300 km alle `NULL` und von „gar nichts in der Nähe" nicht unterscheidbar. Ein `dist_ski_m <= 300000` würde sie stillschweigend ausschließen, der Filter wäre falsch. Also: Slider-Maximum je Kategorie = Cutoff dieser Kategorie. Wird ein Cutoff später erhöht, müssen alle Metriken über `features_epoch` neu berechnet werden.

> **Umgesetzt:** die Cutoffs liegen in [geo-metric-categories.ts](server/utils/geo-metric-categories.ts), gelesen von Job *und* Filter. Ein größerer Wert wird dort **gekappt statt abgewiesen** — abweichend vom Absatz oben: über den Cutoff hinaus liefert die Vorberechnung `NULL`, ein größerer Radius fände also *weniger* Treffer als ein kleinerer. Alles innerhalb des Cutoffs ist auf die weitere Anfrage weiterhin eine richtige (nur unvollständige) Antwort; den Filter ganz zu verwerfen würde stattdessen Auktionen fernab des Merkmals liefern, ein 400 würde eine sonst gültige Suche abbrechen.

Umfang: 37 geocodierte Auktionen × ~14 Kategorien ≈ 500 Lookups; nach [WP-3](2026-08-04-gis-wp3-geocoding-abdeckung.md) 2 785 × 14 ≈ 39 000. **Die Laufzeit dafür ist erst nach der Messung in WP-4 bekannt** — die 147 ms aus der Prod-Messung sind die falsche Bezugsgröße (Rohtabelle, `::geography`-Cast, unzerlegte Geometrien) und ergäben hochgerechnet 95 Minuten. Mit dem fertigen Layer ist ein Bruchteil zu erwarten; die Zahl aus WP-4 Schritt 4 einsetzen, statt hier zu schätzen. Parallelität begrenzt das Connection-Limit des Jobs, nicht die CPU.

**Inkrementell**, nicht immer alles: neu berechnen, wenn keine Zeile existiert, `features_epoch` von WP-4 abweicht, oder `point_hash` sich geändert hat (Auktion wurde neu geocodiert). Im Normalbetrieb sind das eine Handvoll Auktionen pro Lauf.

Randbedingungen wie in WP-4: eigener Connection-Pool mit hartem Limit, off-peak, Batch-Commits, Abbruch-Signal beachten.

## Umstellung der Suche

[auction-search-filters.ts](server/utils/auction-search-filters.ts) ist die einzige Stelle, die angefasst werden muss — sie wird von **beiden** Endpoints geteilt ([auctions.get.ts](server/api/auctions.get.ts), [auctions-geo.get.ts](server/api/auctions-geo.get.ts)), und das ist Absicht: „ein Marker, den die Liste nicht zeigt, oder eine Karte ohne Marker liest sich als kaputter Filter".

Die Tag-Matcher werden zu Spaltennamen — umgesetzt als [geo-metric-categories.ts](server/utils/geo-metric-categories.ts), gemeinsam mit dem Job, weil beide Seiten sich über den Cutoff einig sein müssen:

```ts
export const GEO_METRIC_CATEGORIES = [
  { param: 'nearSea', column: 'dist_sea_m', kind: 'sea', cutoffMeters: 200_000 },
  { param: 'nearMountain', column: 'dist_mountain_m', kind: 'peak', cutoffMeters: 50_000 },
  …
]
```

Und das Prädikat wird aus dem `EXISTS`/`ST_DWithin`-Block ([osm-proximity.ts:50-54](server/utils/osm-proximity.ts#L50-L54)) ein Vergleich: `m.dist_sea_m <= $n`. Jede Query, die dieses Prädikat verwendet, braucht dafür den `LEFT JOIN auction_geo_metrics m` ([GEO_METRICS_JOIN_SQL](server/api/auctions.get.ts)) — auch die schmale Marker-Query von `auctions-geo.get.ts`, die sonst auf ein nicht existierendes `m` verweist.

Die Landing-Rails ([rails.get.ts](server/api/landing/rails.get.ts)) haben dieselbe Query-Form mit festem Radius und dasselbe Kostenproblem und sind mit umgestellt.

`osm-proximity.ts` **bleibt trotzdem** — der `urbanRural`-Filter nutzt `proximityConditionAnyOf` weiter live und braucht ein eigenes Feld (z. B. `dist_city_m`) statt einer Sonderbehandlung; erst danach kann die Datei entfallen. Siehe „Bewusst zurückgestellt" oben.

Der Standort-Filter (`nearLat`/`nearLng`, [Zeile 183-192](server/utils/auction-search-filters.ts#L183-L192)) bleibt **unverändert live** — er vergleicht die Nutzerposition mit der Auktionsposition, nicht mit OSM-Daten, und ist damit billig. (Er profitiert allerdings von einem Geo-Index auf der Auktionsposition, den es heute nicht gibt; separat bewerten.)

### Zwei Fallstricke beim Umstellen

**`LEFT JOIN`, nicht `JOIN`.** Auktionen ohne Koordinaten haben keine Metrikzeile. Ein `JOIN` würde sie aus *jeder* Suche entfernen, auch ohne aktiven Geofilter — bei heute 37 von 3 720 geocodierten Auktionen wären das 99 % der Treffer. Nur wenn ein Geofilter aktiv ist, dürfen sie herausfallen.

**Ergebnismengen werden sich ändern**, und das ist korrekt: die Distanz ist jetzt exakt statt tag-approximiert, und `lake` schließt Flussflächen aus. Abweichungen müssen aber *erklärbar* sein — nicht „ungefähr gleich viele Treffer", sondern für Stichproben nachvollziehbar.

## Verifikation

1. `EXPLAIN (ANALYZE)` der umgestellten `nearSea`-Suche: kein `osm_local_elements` im Plan, keine Geometriefunktion. Ziel < 200 ms europaweit, gegen 16 585 ms heute.
2. Mehrkriterien-Suche (`nearSea=5&nearSki=50`) — der Fall, der heute gar nicht praktikabel ist.
3. Alt gegen neu für 5 Filterkombinationen vergleichen; jede Abweichung einzeln begründen.
4. `/api/auctions` und `/api/auctions-geo` liefern für identische Parameter konsistente Mengen (Marker ⊆ Treffer).
5. Suche ohne Geofilter enthält weiterhin alle Auktionen ohne Koordinaten.
6. Landing-Rails liefern dieselben Kacheln wie vorher, nur schneller.
7. Ein zweiter Lauf des Precompute-Jobs schreibt nichts Neues (Idempotenz).
8. `statement_timeout` aus WP-1 **bleibt bestehen** — auch eine schnelle Query braucht die Versicherung.

## Fallstricke

- **`JOIN` statt `LEFT JOIN`** → 99 % der Ergebnisse verschwinden still.
- **Landing-Rails vergessen** → das Kostenproblem bleibt auf der Startseite, der sichtbarsten Seite überhaupt.
- **Cutoff als „keine Angabe" darstellen** → im UI „> 200 km" zeigen, nicht „unbekannt".
- **Metriken nach OSM-Reimport nicht invalidiert** → stille Falschangaben. `features_epoch` ist dafür da; der Reimport muss ihn erhöhen.
- **Alte Filter-Parameter-Namen brechen** → gespeicherte Suchen (`saved-searches`) und Alerts nutzen die URL-Parameter. Namen beibehalten oder migrieren.
