# WP-6 — OSM-Datenausbau: Schweden, Routen, Tourismus

Datum: 2026-08-04
Teil von [GIS-Architektur](2026-08-04-gis-scaling-architecture.md). Abhängig von: [WP-4](2026-08-04-gis-wp4-geo-features.md) (Mapping muss existieren).
Aufwand: 1–2 Tage. **Repo: `~/Projekte/ansible`** (eigenes Repo, eigener PR) + Reimport.

## Status: Code-Änderungen liegen als PR vor

**[ansible#87](https://github.com/haexhub/ansible/pull/87)**, Branch `osm-import-geo-features`, Commit `14ce2f0`. Geändert sind `roles/zvg-immo/files/osm-import/osm-local-elements.lua` und `roles/zvg-immo/templates/osm-import/import.sh.j2`.

Beide Dateien sind syntaktisch geprüft (`luac -p` bzw. Jinja2-Rendering + `sh -n`), aber **nicht** gegen einen echten osm2pgsql-Lauf getestet. Was noch fehlt: Review, Smoke-Test, Merge, Deploy, Reimport, Verifikation.

**Reihenfolge gegenüber [WP-0](2026-08-04-gis-wp0-schema-neuaufbau.md):** Ein OSM-Reimport fällt in beiden WPs an — in WP-0 wegen des Schema-Neuaufbaus, hier wegen der neuen Tags. Er darf **nur einmal** laufen (DE mehrere Stunden). Also: dieses WP zuerst deployen, dann den Reimport auslösen, dann ist er für beide Zwecke erledigt. Läuft WP-0 zuerst mit einem Reimport, muss er nach dem Deploy dieses WPs wiederholt werden.

> **Status 2026-08-05: dieser Fall ist eingetreten — der Reimport steht noch komplett aus.** WP-0 (PR #313, gemergt 2026-08-04) hat `osm_local_elements` per Hard-Reset geleert und den Reimport nicht selbst nachgeholt (verifiziert: 0 Zeilen, 96 kB auf Prod). WP-4 (PR #318, Aufbau-Job für `geo_features`) ist fertig und lokal verifiziert, läuft auf Prod aber gegen diese leere Quelle. Damit ist dieses WP der **aktuelle kritische Pfad**: `ansible#87` gegen einen kleinen Extrakt testen (Bulgarien empfohlen, nicht DE — schneller Turnaround), reviewen, mergen, deployen, dann den DE/SE/BG-Reimport auslösen. Erst danach liefern WP-4 und WP-5 reale Ergebnisse.

## Drei Befunde, die das WP begründen

### 1. Schweden ist nie importiert worden

`osm_local_elements` enthält: DE 43 491 674, BG 1 039 402, **SE 0** — obwohl `europe/sweden` in `defaults/main.yml` konfiguriert ist. Alle SE-Geofilter und die SE-Landing-Rail sind damit funktionslos.

Ursache gefunden: Der Service ist **failed** (`systemctl --user status zvg-immo-osm-import.service`), gekillt am 2026-08-03 19:29:38. `import.sh` benutzte `set -eu` global über die Länderschleife, und DE steht als erstes in der Config (~4 GB Extrakt, Stunden osm2pgsql). Jeder Lauf starb in der DE-Phase und **erreichte SE nie**. Die Zeitstempel bestätigen es: BG wurde 12:30 importiert, DE 15:18, und der 19:29-Lauf hinterließ eine leere `osm_local_elements_staging_de`-Tabelle — er starb wieder in Phase 1.

**Fix (umgesetzt):** Jedes Land läuft in einer eigenen `set -e`-Subshell; Fehler werden gesammelt und am Ende gemeldet, mit Exit-Code 1, aber erst nachdem alle Länder versucht wurden. Ein schlechter Extrakt kostet ein Land statt aller.

### 2. Routen-Relationen werden vollständig verworfen

`process_relation` nahm nur `type=multipolygon`. Wander-, MTB- und Kanurouten sind `type=route`-Relationen und tragen ihre Tags **nur auf der Relation**, nie auf den Mitgliedswegen. Ohne sie sind diese Kategorien nicht ableitbar.

**Fix (umgesetzt):** `type=route` wird mit `as_multilinestring()` übernommen. Wichtig dabei — `as_multipolygon()` auf einer Route ergibt eine leere Geometrie, was die `NOT NULL`-Spalte verletzt und den ganzen Import abbricht. Grenzüberschreitende Routen, die am Extraktrand abgeschnitten sind, liefern ebenfalls leere Geometrien und werden per `geom:is_null()` übersprungen.

### 3. Tourismus- und Ski-Tags fehlen

**Fix (umgesetzt):** ergänzt wurden `landuse=winter_sports`, `aerialway=*` (Lifte), `piste:type`/`sac_scale`/`mtb:scale` als ANY-Value, `route` ∈ {hiking, foot, mtb, bicycle, canoe}, `leisure` ∈ {swimming_area, marina, slipway, fishing, golf_course, water_park, nature_reserve, beach_resort}, `tourism` ∈ {attraction, museum, viewpoint, theme_park, zoo, camp_site, hotel, guest_house, …}, `historic` ∈ {castle, monument, archaeological_site, …}, `sport`, `mtb`, `canoe`, `fishing`, `whitewater`, `amenity` ∈ {spa, public_bath}, `natural` ∈ {cliff, glacier, spring}, `waterway` ∈ {canal, waterfall}.

Zusätzlich protokolliert `import.sh` jetzt nach jedem Lauf invalide Indizes — der Zustand, der wochenlang unentdeckt blieb und den Serverausfall verursachte ([WP-1](2026-08-04-gis-wp1-index-notfall.md)).

## Was `building` betrifft — bewusst nicht angefasst

`building` läuft mit ANY-Value-Semantik und ist **90 % der 44,5 Mio. Zeilen** (~40 Mio.). Es wäre der größte Hebel für Tabellengröße und Reimport-Dauer.

**Trotzdem nicht entfernt**, weil [osm-location-context.ts](server/utils/external-data/osm-location-context.ts) es über `BUILDING_RADIUS_METERS` aktiv nutzt — ein Entfernen würde die Lagequalitäts-Auswertung auf den Detailseiten beschädigen. Der sinnvolle Weg ist, den Informationsgehalt (Bebauungsdichte) als Zahl pro Rasterzelle vorzuberechnen und `building` erst danach aus dem Import zu nehmen. Das ist eigene Arbeit und gehört nicht in dieses WP.

## Offene Schritte

1. **Review der vorliegenden Änderungen** in `roles/zvg-immo/files/osm-import/osm-local-elements.lua` und `roles/zvg-immo/templates/osm-import/import.sh.j2`.
2. **Größenabschätzung vor dem Reimport.** Die neuen ANY-Value-Keys (`piste:type`, `sac_scale`, `mtb:scale`) und `tourism=hotel|guest_house|apartment` vergrößern die Tabelle. Erwartung: einige Hunderttausend Zeilen, also unkritisch neben 40 Mio. `building` — aber vor dem Lauf gegen ein kleines Extrakt (Bulgarien, ~200 MB) prüfen, nicht gegen Deutschland.
3. **Smoke-Test gegen echtes osm2pgsql.** Der bestehende Header-Kommentar dokumentiert genau dieses Vorgehen für die letzte Änderung („smoke-tested … with the bulgaria extract"). Syntaxprüfung allein reicht nicht: Fehler in der Flex-API (falscher Geometrietyp, fehlende Methode) zeigen sich erst zur Laufzeit.
4. **Commit, PR, Deploy** im ansible-Repo.
5. **Reimport auslösen** — alle drei Länder. Dauer: DE mehrere Stunden. Off-peak, und mit Blick auf den Connection-Verbrauch: derselbe Job hat am 2026-08-03 einen Prod-Totalausfall verursacht.
6. **[WP-4](2026-08-04-gis-wp4-geo-features.md)-Aufbau erneut laufen lassen** und `features_epoch` erhöhen, damit [WP-5](2026-08-04-gis-wp5-precompute-suche.md) die Metriken neu berechnet.

## Verifikation

1. `SELECT country, count(*) FROM osm_local_elements GROUP BY 1` zeigt **alle drei** Länder, SE > 0.
2. `systemctl --user status zvg-immo-osm-import.service` ist nicht mehr `failed`.
3. Ein absichtlich fehlerhaftes Land (z. B. ungültiger geofabrik_path in einer Testkonfiguration) blockiert die anderen nicht.
4. Stichproben je neuer Kategorie:
```sql
SELECT count(*) FROM osm_local_elements WHERE tags ? 'piste:type';
SELECT count(*) FROM osm_local_elements WHERE tags->>'landuse' = 'winter_sports';
SELECT count(*) FROM osm_local_elements WHERE osm_type='relation' AND tags->>'route' = 'hiking';
```
Alle > 0. Der dritte Wert ist der wichtigste — er beweist, dass Routen-Relationen ankommen.
5. **Ski-Abdeckung je Land plausibilisieren.** Skigebiete sind in OSM [uneinheitlich erfasst](https://wiki.openstreetmap.org/wiki/Tag:landuse=winter_sports); für 2–3 bekannte Gebiete je Land prüfen, ob sie über mindestens einen der drei Tags auffindbar sind. Ein Land mit 0 Skigebieten kann korrekt sein (BG hat welche, SE hat welche — bei 0 liegt ein Mapping-Fehler vor).
6. Keine leeren Geometrien: `SELECT count(*) FROM osm_local_elements WHERE ST_IsEmpty(geom)` = 0.
7. Der Invalid-Index-Check im Joblog gibt keine Zeilen aus.

## Fallstricke

- **Reimport ohne WP-4-Neuaufbau** → `geo_features` bleibt auf altem Stand, die neuen Kategorien sind unsichtbar, und es sieht wie ein Fehler in WP-4 aus.
- **`as_multipolygon()` auf Routen** → leere Geometrie, `NOT NULL`-Verletzung, Abbruch des gesamten Imports.
- **DE zuerst importieren** und dann abbrechen → wieder kein SE. Mit der Subshell-Isolation entschärft, aber die Reihenfolge bleibt ungünstig; alternativ kleinste Extrakte zuerst konfigurieren.
- **`sac_scale` als ANY-Value** kann in Alpenländern viele Wege bringen. Bei einer späteren AT/CH-Erweiterung neu bewerten.
- **Verwaiste Staging-Tabellen:** `import.sh` droppt sie jetzt vor dem Import. Eine existierte bereits (`osm_local_elements_staging_de`, leer) — sie wäre sonst vom Swap-Schritt als frische Daten interpretiert worden.
