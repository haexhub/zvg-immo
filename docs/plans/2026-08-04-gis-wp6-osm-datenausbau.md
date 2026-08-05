# WP-6 — OSM-Datenausbau: Schweden, Routen, Tourismus

Datum: 2026-08-04
Teil von [GIS-Architektur](2026-08-04-gis-scaling-architecture.md). Abhängig von: [WP-4](2026-08-04-gis-wp4-geo-features.md) (Mapping muss existieren).
Aufwand: 1–2 Tage. **Repo: `~/Projekte/ansible`** (eigenes Repo, eigener PR) + Reimport.

## Status: Code gemergt + deployed, Smoke-Test bestanden — Reimport ist der letzte Schritt

**[ansible#87](https://github.com/haexhub/ansible/pull/87)**, Commit `14ce2f0`, **gemergt 2026-08-04 12:49 UTC** (`master` HEAD `85a5e20`) — bereits **auf Prod deployed** (`osm-local-elements.lua` md5sum-identisch mit dem gemergten Commit, verifiziert 2026-08-05).

**Smoke-Test 2026-08-05: bestanden.** Der PR-Kommentar "kein Smoke-Test" bezog sich auf den zum Merge-Zeitpunkt ungetesteten Stand; der Datei-Header-Kommentar ("smoke-tested … with the bulgaria extract") bezieht sich nachweislich auf die *vorherige* Änderung (Sea-Tag-Broadening, Commit `2147f8b`), nicht auf `type=route`/Tourismus-Tags aus diesem PR. Test lief **isoliert** (kein Prod-Zugriff): `postgis/postgis:17-3.4`-Container + `debian:stable-slim` mit `osm2pgsql 2.1.1` (identisch zur Prod-Konfiguration) gegen den echten Bulgarien-Extrakt (~173 MB, download.geofabrik.de), exakt den Befehlen aus `import.sh.j2` folgend (inkl. Swap-Transaktion in eine lokale Kopie der echten `osm_local_elements`-DDL).

Ergebnis: **keine Laufzeitfehler** — kein Flex-API-Crash, keine `NOT NULL`-Verletzung durch leere Routen-Geometrien. 1 066 969 Zeilen für BG (vorher 1 039 402 — +2,6 %, wie erwartet unkritisch). Alle Verifikationspunkte unten grün, inkl. `piste:type` (267), `landuse=winter_sports` (12), Routen-Relationen mit `route=hiking` (543), 0 leere Geometrien. Ski-Stichprobe: Bansko/Pamporovo per Namenssuche direkt gefunden; Borovets zunächst 0 Treffer, weil die Lifte/Pisten dort unbenannt sind (normales OSM-Tagging) — räumliche Suche um den benannten Ortsknoten "Боровец" bestätigt Lifte/Pisten in 245–380 m Entfernung, also kein Mapping-Fehler.

**Offen bleibt nur noch:** der eigentliche DE/SE/BG-Reimport auf Prod (siehe „Offene Schritte" Punkt 5) — dieser WP-Teil ist damit **fertig für den Reimport**, nicht mehr Blocker davor.

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

1. ~~Review der vorliegenden Änderungen~~ — erledigt (Merge 2026-08-04).
2. ~~Größenabschätzung vor dem Reimport~~ — erledigt: BG-Smoke-Test zeigt +2,6 % gegenüber dem alten BG-Bestand (1 066 969 vs. 1 039 402 Zeilen), unkritisch.
3. ~~Smoke-Test gegen echtes osm2pgsql~~ — erledigt 2026-08-05, siehe Status-Abschnitt oben.
4. ~~Commit, PR, Deploy~~ — erledigt (PR #87 gemergt + deployed, Lua-Datei md5sum-verifiziert).
5. **Reimport auslösen — alle drei Länder. Wartet auf explizite Freigabe** (mehrstündige, hohe Prod-Last erzeugende Operation, siehe [[prod-outage-osm-import-connection-exhaustion]]-Vorfall vom 2026-08-03). Der Job läuft als `haex-service`-User-systemd-Unit (nicht `haex`), `haex` hat dafür passwortlosen `sudo -u haex-service`:
   ```sh
   ssh haex.cloud 'sudo -u haex-service XDG_RUNTIME_DIR=/run/user/1001 systemctl --user start zvg-immo-osm-import.service'
   ```
   Fortschritt/Fehler live verfolgen:
   ```sh
   ssh haex.cloud 'sudo -u haex-service XDG_RUNTIME_DIR=/run/user/1001 journalctl --user -u zvg-immo-osm-import.service -f'
   ```
   `TimeoutStartSec=21600` (6 h) im Service-Unit deckt alle drei Länder ab (DE allein ~1h42m gemessen). Off-peak fahren, wegen Connection-Verbrauch während des Laufs.
6. **[WP-4](2026-08-04-gis-wp4-geo-features.md)-Aufbau erneut laufen lassen** und `features_epoch` erhöhen, damit [WP-5](2026-08-04-gis-wp5-precompute-suche.md) die Metriken neu berechnet.

## Verifikation

Punkte 4–6 bereits im isolierten BG-Smoke-Test (2026-08-05) bestätigt — dort schon grün, nach dem echten Reimport nur gegen alle drei Länder wiederholen. Punkte 1–3 und 7 brauchen den echten Prod-Reimport.

1. `SELECT country, count(*) FROM osm_local_elements GROUP BY 1` zeigt **alle drei** Länder, SE > 0.
2. `systemctl --user status zvg-immo-osm-import.service` ist nicht mehr `failed`.
3. Ein absichtlich fehlerhaftes Land (z. B. ungültiger geofabrik_path in einer Testkonfiguration) blockiert die anderen nicht.
4. Stichproben je neuer Kategorie:
```sql
SELECT count(*) FROM osm_local_elements WHERE tags ? 'piste:type';
SELECT count(*) FROM osm_local_elements WHERE tags->>'landuse' = 'winter_sports';
SELECT count(*) FROM osm_local_elements WHERE osm_type='relation' AND tags->>'route' = 'hiking';
```
Alle > 0. Der dritte Wert ist der wichtigste — er beweist, dass Routen-Relationen ankommen. **BG-Smoke-Test:** 267 / 12 / 543.
5. **Ski-Abdeckung je Land plausibilisieren.** Skigebiete sind in OSM [uneinheitlich erfasst](https://wiki.openstreetmap.org/wiki/Tag:landuse=winter_sports); für 2–3 bekannte Gebiete je Land prüfen, ob sie über mindestens einen der drei Tags auffindbar sind. Ein Land mit 0 Skigebieten kann korrekt sein (BG hat welche, SE hat welche — bei 0 liegt ein Mapping-Fehler vor). **BG-Smoke-Test:** Bansko/Pamporovo/Borovets alle bestätigt (Borovets nur räumlich, nicht per Namenssuche — Lifte dort unbenannt).
6. Keine leeren Geometrien: `SELECT count(*) FROM osm_local_elements WHERE ST_IsEmpty(geom)` = 0. **BG-Smoke-Test:** bestätigt, 0.
7. Der Invalid-Index-Check im Joblog gibt keine Zeilen aus.

## Fallstricke

- **Reimport ohne WP-4-Neuaufbau** → `geo_features` bleibt auf altem Stand, die neuen Kategorien sind unsichtbar, und es sieht wie ein Fehler in WP-4 aus.
- **`as_multipolygon()` auf Routen** → leere Geometrie, `NOT NULL`-Verletzung, Abbruch des gesamten Imports.
- **DE zuerst importieren** und dann abbrechen → wieder kein SE. Mit der Subshell-Isolation entschärft, aber die Reihenfolge bleibt ungünstig; alternativ kleinste Extrakte zuerst konfigurieren.
- **`sac_scale` als ANY-Value** kann in Alpenländern viele Wege bringen. Bei einer späteren AT/CH-Erweiterung neu bewerten.
- **Verwaiste Staging-Tabellen:** `import.sh` droppt sie jetzt vor dem Import. Eine existierte bereits (`osm_local_elements_staging_de`, leer) — sie wäre sonst vom Swap-Schritt als frische Daten interpretiert worden.
