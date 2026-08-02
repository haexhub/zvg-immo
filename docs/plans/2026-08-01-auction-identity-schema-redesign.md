# Auction-Identität + versionierte Extraktion — Redesign

**Status (2026-08-02): vollständig umgesetzt.** WP-0 bis WP-7 und der Nachtrag
WP-8 bis WP-11 sind abgeschlossen. Die abschließende fachliche Entscheidung
lautet: kein Legacy-Burn-in und keine Datenmigration; der kleine Bestand wird
gelöscht und per Vollcrawl neu aufgebaut.

Damit sind `extraction_cache`/`auction_snapshot`, ihre Module, Backfill-Skripte,
Dual-Writes und Hash-Kompatibilitätsfelder entfernt. `auctions` enthält nur noch
Identitäts-/Terminfelder; `auction_details`, `auction_photos`,
`auction_fetch_state`, `artifact_versions` und der gemeinsame Aggregat-Reader
bilden den alleinigen Contract. Frühere Backfill-/Burn-in-Abschnitte weiter
unten bleiben nur als verworfener Entscheidungsverlauf erhalten.

## Historischer Anhang (nicht ausführbar)

Alles ab hier dokumentiert ausschließlich den verworfenen Planungs- und
Entscheidungsverlauf. Insbesondere sind sämtliche DDL-/Migrations-Snippets,
Backfills, Burn-in-Schritte, Dual-Writes, offenen Punkte und WP-2-Anweisungen
**nicht auszuführen**. Der verbindliche Contract steht ausschließlich im
Statusblock oben: direkter Cutover, vollständiger Recrawl, keine Legacy-Pfade.

### Wie es dazu kam

Ausgangsfrage: "die FK-Beziehungen zwischen `extraction_cache`, `auction_snapshot`,
`location_enrichment`, `auction_translations` (alle mit `platform`+`external_id`,
aber ohne FK) wirken schlecht modelliert." Erste Analyse ergab: das ist kein
Versehen, sondern Konsequenz davon, dass `auctions` **kein Master war, sondern ein
abgeleiteter SQL-Spiegel**, der spät (oder in manchen Schreibpfaden nie)
geschrieben wurde, plus der damaligen Permalink-Retention-Entscheidung. Ein
konkreter Bug wurde dabei gefunden und bereits
gefixt: `country-rebuild.ts` räumte `location_enrichment`/`auction_translations`
beim Länder-Reset nicht mit auf (**PR #289, gemergt**).

Der Nutzer wollte daraufhin die Architektur nicht nur reparieren, sondern **von
Grund auf neu denken**: `auctions` soll die echte Master-Identität
werden, an der alle Artefakte (Dokumente/Bilder) und alle abgeleiteten Daten
hängen — mit voller Versionshistorie statt Überschreiben, damit sich jederzeit
nachvollziehen lässt, was sich zwischen Versionen geändert hat, ohne alte Daten
zu verlieren.

### Zielarchitektur — Übersicht

| Tabelle heute | Tabelle neu | Rolle |
|---|---|---|
| `auctions` | `auctions` (schlanker) | Master-Identität: Land, Region, Gericht, Aktenzeichen, Titel, Termin, Status. Beim expliziten Länder-Rebuild gelöscht und frisch erzeugt. |
| `raw_blobs` | `artifact_blobs` | Content-adressierter Zeiger auf S3 (kein Byte-Inhalt in der DB) |
| `raw_captures` | `artifact_captures` | Append-only-Log jedes Fetches |
| `raw_document_sets` | `artifact_versions` | Vollständiges Artefakt-Manifest pro Version ("Artefakt-Version") |
| `raw_document_set_items` | `artifact_version_items` | Welche Datei gehört zu welchem Manifest |
| `extraction_cache` + `auction_snapshot` | **`auction_details`** (neu) | Typisiert, versioniert ("Extraktions-Version", eigener Zähler), nie überschrieben |
| `location_enrichment` | `location_enrichment` | unverändert, bekommt echte FK auf `auctions` |
| `auction_translations` | `auction_translations` | bekommt `version`-Spalte, FK auf `auction_details` statt nur `auctions` |

**Zwei unabhängige Versionszähler, bewusst getrennt** (das war der Kern der
Diskussion): `artifact_versions.version` zählt Änderungen am **Dokumentenbestand**
(neues/entferntes/geändertes PDF). `auction_details.version` zählt Änderungen am
**Extraktionsergebnis** — ausgelöst entweder durch eine neue `artifact_versions`-
Version ODER durch einen manuellen Reprocess mit *denselben* Dokumenten (neuer
Prompt/neues Modell — das ist heute schon ein realer, genutzter Fall in
`reprocess.ts`). Jede `auction_details`-Zeile trägt eine FK, welches Artefakt-
Manifest sie ausgewertet hat, damit beide Auslöser unterscheidbar bleiben.

### Datenmodell (historischer DDL-Entwurf, nicht ausführen)

```sql
-- auctions: Master-Identität. Wird beim allerersten Crawl-Sichten angelegt
-- (Land/Region/Gericht/Aktenzeichen/Termin sind ohne Dokumenten-Parsing bekannt),
-- danach nur noch in-place geupdated. Ein expliziter Länder-Rebuild löscht
-- den vollständigen Ländergraphen und erzeugt ihn per Crawl neu.
CREATE TABLE auctions (
  platform      text NOT NULL,
  external_id   text NOT NULL,
  country       text NOT NULL,
  region        text NOT NULL,
  authority     text NOT NULL,
  case_number   text NOT NULL,
  title         text,
  auction_date_iso timestamptz,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, external_id)
);
-- "beendet" ist reine Lesezeit-Berechnung, keine eigene Spalte/Pflege:
--   status = 'active' AND auction_date_iso < now()

-- Backfill VOR den FKs unten: archiveDocumentSet/reprocess.ts können heute
-- raw_captures/raw_document_sets-Zeilen schreiben, bevor je eine auctions-
-- Zeile existiert (siehe Punkt 1 unter "Im Gespräch geklärte Entscheidungen" —
-- WP-1 erzwingt das nur für künftige Schreibpfade). Ein direktes ADD
-- CONSTRAINT würde auf diesen bestehenden verwaisten Zeilen fehlschlagen.
-- Deshalb: erst Identität nachziehen (die denormalisierten Spalten sind zu
-- diesem Zeitpunkt noch vorhanden), DANN droppen, DANN FK als NOT VALID
-- hinzufügen und validieren (blockiert keine parallelen Writes länger als der
-- Constraint-Check selbst):
INSERT INTO auctions (platform, external_id, country, region, authority, case_number, auction_date_iso, status)
SELECT DISTINCT ON (platform, external_id) platform, external_id, country, region, authority, case_number, NULL, 'active'
FROM artifact_captures
ON CONFLICT (platform, external_id) DO NOTHING;
-- analog für jede (platform, external_id)-Kombination aus artifact_versions,
-- die obiger INSERT noch nicht abgedeckt hat (gleiches Muster). Abweichende
-- Identitätsfelder zwischen mehreren Captures derselben Auktion sind
-- unkritisch — der nächste reguläre Crawl-Lauf aktualisiert sie ohnehin über
-- den normalen Upsert (Punkt 2 unten).

-- artifact_blobs (= heutiges raw_blobs, umbenannt)
-- artifact_captures (= heutiges raw_captures, umbenannt) + neue FK. country/
-- region/authority/case_number werden dabei gedroppt (waren nur denormalisiert,
-- weil es vorher keinen verlässlichen auctions-Anker gab) — bei Bedarf per
-- JOIN auf auctions holen. Ein Gerichtswechsel/Aktenzeichen-Neuvergabe würde
-- ohnehin praktisch immer eine neue external_id bedeuten, also eigene
-- Identität — kein Grund, den alten Stand pro Capture einzufrieren.
ALTER TABLE artifact_captures DROP COLUMN country, DROP COLUMN case_number, DROP COLUMN authority;
ALTER TABLE artifact_captures
  ADD CONSTRAINT fk_artifact_captures_auction
  FOREIGN KEY (platform, external_id) REFERENCES auctions (platform, external_id) NOT VALID;
ALTER TABLE artifact_captures VALIDATE CONSTRAINT fk_artifact_captures_auction;

-- artifact_versions (= heutiges raw_document_sets, umbenannt) + neue FK, gleiche
-- Spalten-Bereinigung (country/region/case_number/authority raus). Zusätzlich
-- eine UNIQUE-Spalte auf (id, platform, external_id) — Voraussetzung für die
-- zusammengesetzte FK von auction_details unten (stellt sicher, dass eine
-- auction_details-Zeile nur ein artifact_versions-Manifest der EIGENEN Auktion
-- referenzieren kann):
ALTER TABLE artifact_versions DROP COLUMN country, DROP COLUMN region, DROP COLUMN case_number, DROP COLUMN authority;
ALTER TABLE artifact_versions
  ADD CONSTRAINT fk_artifact_versions_auction
  FOREIGN KEY (platform, external_id) REFERENCES auctions (platform, external_id) NOT VALID;
ALTER TABLE artifact_versions VALIDATE CONSTRAINT fk_artifact_versions_auction;
ALTER TABLE artifact_versions
  ADD CONSTRAINT uq_artifact_versions_identity UNIQUE (id, platform, external_id);

-- artifact_version_items (= heutiges raw_document_set_items, umbenannt, unverändert)

-- auction_details: NEU. Typisierte, versionierte Extraktion. Jede Zeile ist
-- unveränderlich (nie UPDATE) — das *ist* die Historie.
CREATE TABLE auction_details (
  id                    bigserial PRIMARY KEY,
  platform              text NOT NULL,
  external_id           text NOT NULL,
  version               integer NOT NULL,        -- eigener Zähler, siehe oben
  artifact_version_id   bigint,  -- NULL = nur aus Listing-Daten (noch keine Dokumente geparst)
  created_at            timestamptz NOT NULL DEFAULT now(),  -- Zeitpunkt des INSERTs (Housekeeping)
  extracted_at          timestamptz NOT NULL,  -- fachlicher Extraktions-Zeitpunkt, = AuctionExtraction.at; NICHT durch created_at ersetzbar (kann von created_at abweichen, z.B. bei Backfill/Replay)
  -- Objekt-/Preisdaten, analog den heutigen `auctions`-Spalten + extraction_cache-Feldern:
  address               text,
  description           text,
  property_type         text,
  land_area_sqm         numeric,
  living_area_sqm       numeric,
  rooms                 numeric,
  bedrooms              numeric,
  bathrooms             numeric,
  floor                 text,
  bathroom_has_tub      boolean,
  bathroom_has_shower   boolean,
  heating               text,
  units                 integer,
  year_built            integer,
  last_renovation_year  integer,
  market_value          numeric,
  currency              text,
  market_value_eur      numeric,
  condition             jsonb,
  features              text[],
  insights              jsonb,        -- AuctionInsights
  planning_notes        jsonb,        -- PlanningNotes (Denkmalschutz/Altlasten/Bauleitplanung/...)
  renovation_notes      text,
  starting_bid          numeric,
  current_bid           numeric,
  source_security_deposit numeric,
  security_deposit      numeric,
  bidding_notes         text,
  photo_count           integer NOT NULL DEFAULT 0,
  thumbnail_url         text,
  lat                   numeric,
  lng                   numeric,
  extraction_source     text,
  extraction_confidence text,
  llm_analyzed_at       timestamptz,  -- AuctionExtraction.llmAnalyzedAt
  document_summary      text,
  extraction_texts      jsonb,
  FOREIGN KEY (platform, external_id) REFERENCES auctions (platform, external_id),
  -- Zusammengesetzte FK statt nur REFERENCES artifact_versions (id): verhindert,
  -- dass eine auction_details-Zeile das Manifest einer FREMDEN Auktion
  -- referenziert (artifact_version_id allein garantiert das nicht). NULL bleibt
  -- erlaubt (Postgres prüft eine FK mit NULL-Spalte per MATCH SIMPLE nicht).
  FOREIGN KEY (artifact_version_id, platform, external_id)
    REFERENCES artifact_versions (id, platform, external_id),
  UNIQUE (platform, external_id, version)
);
CREATE INDEX idx_auction_details_identity_version ON auction_details (platform, external_id, version DESC);
-- Für "aktueller Stand"-Filterabfragen (Suche/Karte), siehe WP-3:
CREATE INDEX idx_auction_details_property_type ON auction_details (property_type);
CREATE INDEX idx_auction_details_living_area ON auction_details (living_area_sqm);
CREATE INDEX idx_auction_details_land_area ON auction_details (land_area_sqm);
CREATE INDEX idx_auction_details_year_built ON auction_details (year_built);

-- auction_translations: + version-Spalte, FK jetzt auf auction_details statt
-- nur auctions (Inhalt ist versionsabhängig — eine neue Version kann Titel/
-- Beschreibung ändern, alte Übersetzungen bleiben als Historie stehen).
-- NOT NULL kann nicht direkt per ADD COLUMN auf eine gefüllte Tabelle — Spalte
-- nullable anlegen, backfillen (WP-4: bestehende Zeilen bekommen version = 1,
-- vorausgesetzt der auction_details-Backfill aus WP-2 hat für dieselbe
-- (platform, external_id) bereits eine version = 1-Zeile erzeugt), dann erst
-- NOT NULL setzen:
ALTER TABLE auction_translations ADD COLUMN version integer;
UPDATE auction_translations SET version = 1;
ALTER TABLE auction_translations ALTER COLUMN version SET NOT NULL;
-- PK wird (platform, external_id, version, lang) statt (platform, external_id,
-- lang) — alter PK lässt sonst keine zweite Version derselben Sprache zu:
ALTER TABLE auction_translations DROP CONSTRAINT auction_translations_pkey;
ALTER TABLE auction_translations ADD PRIMARY KEY (platform, external_id, version, lang);
-- FK erst NACH dem auction_details-Backfill aus WP-2 hinzufügen, sonst schlägt
-- sie für jede Zeile ohne passende auction_details-Version fehl:
ALTER TABLE auction_translations
  ADD CONSTRAINT fk_auction_translations_details
  FOREIGN KEY (platform, external_id, version) REFERENCES auction_details (platform, external_id, version);

-- location_enrichment: unverändert, + echte FK (unversioniert — Standort
-- ändert sich nicht zwischen Extraktions-Versionen):
ALTER TABLE location_enrichment
  ADD CONSTRAINT fk_location_enrichment_auction
  FOREIGN KEY (platform, external_id) REFERENCES auctions (platform, external_id);
```

### Historischer Entscheidungsverlauf

Die Punkte in diesem Abschnitt dokumentieren die ursprüngliche Planung. Die
spätere, verbindliche Recrawl-Entscheidung am Dokumentanfang ersetzt insbesondere
die Aussagen zu Retention, Backfill und Dual-Write.

1. **Warum keine FK bisher:** `auctions` wurde bisher zuletzt (`enrich.ts`, nach
   `writeExtractionCache`/`writeAuctionSnapshot`) oder gar nicht
   (`reprocess.ts`, `llm-batch-poll.ts`) beschrieben — eine FK darauf hätte diese
   Schreibpfade sofort brechen lassen. Löst sich durch Punkt 2.
2. **`auctions`-Zeile entsteht beim allerersten Crawl** (in `refresh.ts`, bevor
   Dokumente/Extraktion überhaupt laufen) — `country`/`region`/`authority`/
   `case_number`/`auction_date_iso` sind zu diesem Zeitpunkt schon aus dem reinen
   Listing bekannt, kein Dokumenten-Parsing nötig. Damit existiert die Identität
   garantiert, bevor irgendein Artefakt/Extraktions-Datensatz dazu geschrieben
   wird — auch für `reprocess.ts`/`llm-batch-poll.ts`, die immer eine bereits
   gecrawlte Auktion bearbeiten.
3. **Ursprünglich geplant war: `auctions` wird nie gelöscht** — auch nicht beim Länder-Rebuild. Ersetzt die
   heutige Permalink-Retention-Sonderregel für `auction_snapshot`/
   `extraction_cache` (siehe Memory `wp5-snapshot-no-prune-intentional`) durch
   ein einheitliches Prinzip für die ganze Kette.
4. **`artifact_versions` (bisher `raw_document_sets`) ist bereits exakt das
   "Artefakt mit Version"-Konzept** — jede Version ist ein vollständiges
   Manifest (auch unveränderte Dateien werden erneut gelistet, kein Diff), genau
   wie gewünscht. Hier ist strukturell nichts Neues zu bauen, nur umzubenennen +
   FK zu ergänzen.
5. **`auction_details.version` ist ein eigener Zähler**, unabhängig von
   `artifact_versions.version` — deckt sowohl "neue Dokumente" als auch "gleiche
   Dokumente, neuer LLM-Lauf" ab. Jede Zeile referenziert per
   `artifact_version_id`, welches Manifest ausgewertet wurde.
6. **Kein JSON-Blob** — `auction_details` bekommt typisierte Spalten (wie heute
   `auctions`), damit SQL-Diffing zwischen Versionen möglich ist ("wo hat sich
   `living_area_sqm` geändert"). `condition`/`extraction_texts` bleiben `jsonb`,
   weil sie selbst schon strukturierte Unterobjekte sind, kein Diffing-Ziel.
7. **`location_enrichment` hängt unversioniert an `auctions`** (Standort ändert
   sich nicht zwischen Extraktions-Versionen). **`auction_translations` hängt
   versioniert an `auction_details`** (Inhalt ändert sich mit der Version, alte
   Übersetzungen bleiben als Historie erhalten statt überschrieben zu werden).
8. **Ändert sich `lat`/`lng` zwischen zwei `auction_details`-Versionen
    spürbar** (Toleranzschwelle wegen Geocoding-Rauschen, keine exakte
    Gleichheit), wird `location_enrichment` einfach aktualisiert (überschrieben,
    keine eigene Versionierung). **Verifiziert am echten Code
    (`server/tasks/external-enrichment.ts`, `nuxt.config.ts`):** der Task läuft
    heute per Cron `15 3 * * *` als **blinder, unbedingter Voll-Sweep über alle
    Auktionen** — kein `checked_at`-Staleness-Gate, das ein Zurücksetzen
    beeinflussen würde. Dieser Voll-Sweep bleibt bestehen, weil ein Teil der
    Adapter (EU-Hochwasserrisiko, Copernicus-EFFIS, EEA-Lärm, CAMS-Luftqualität)
    von **extern, unabhängig von der Auktion aktualisierten Datensätzen**
    abhängt — eine neue Hochwasserzone kann eine unveränderte Auktion betreffen,
    ohne dass irgendein auktionsseitiger Trigger das je auslösen würde. Für den
    Fall "Adresse/Koordinaten dieser einen Auktion haben sich geändert" reicht
    der nächtliche Sweep aber nicht (bis zu 24h falsche Anzeige) — zusätzlich
    ein **sofortiger, gezielter, detachter Trigger**: der Writer aus WP-2 (bzw.
    WP-1 für neu angelegte Auktionen) ruft `runExternalEnrichment({ platform,
    externalId })` fire-and-forget auf (Funktion unterstützt Einzel-Auktions-
    Scope bereits über `options.platform`/`options.externalId`; das
    "detached"-Muster existiert schon für den manuellen `/settings`-Trigger).
    Kein synchrones Warten im Extraktionspfad auf externe HTTP-Latenzen.
9. **`auctions.status`**: nur `active`/`cancelled` werden aktiv gepflegt
   (`cancelled` vom Crawler gesetzt, sobald er eine Absage erkennt). `beendet`
   wird NICHT gespeichert, sondern bei jedem Read aus `auction_date_iso < now()`
   berechnet — kein Cron-Job, der veralten kann.
10. **Artefakte (Bilder/Dokumente/HTML) hängen über `artifact_version_id` an
   `auction_details`**, nicht als eigene Spalten dort — die 1:n-Liste "welche
   Dateien genau" bleibt in `artifact_version_items`, `auction_details`
   referenziert nur das Manifest.
11. **`country`/`region`/`authority`/`case_number` werden von
   `artifact_captures`/`artifact_versions` gedroppt** (waren nur denormalisiert,
   weil vorher kein verlässlicher `auctions`-Anker existierte) — bei Bedarf per
   JOIN auf `auctions` holen. Ein Gerichtswechsel würde ohnehin praktisch immer
   eine neue `external_id` bedeuten (andere Quelle = eigene Identität), es gibt
   also keinen Fall, in dem der alte, pro Capture eingefrorene Stand gebraucht
   würde.

### Historische offene Punkte (verworfen, nicht ausführen)

Diese Punkte sind inzwischen durch die Umsetzung und die Recrawl-Entscheidung
aufgelöst; sie bleiben nur zur Nachvollziehbarkeit erhalten:

- **`address` liegt in `auction_details`, nicht in `auctions`.** Der Nutzer
  nannte für `auctions` explizit nur "Land, Ort, ID/Aktenzeichen, Termin" — "Ort"
  wurde hier als Land/Region/Gerichtsbezirk interpretiert (schon durch
  `country`/`region`/`authority` gedeckt), nicht als konkrete Straßenadresse.
  Die Adresse hängt am `lat`/`lng`-Geocoding, das durchaus versionsabhängig
  korrigiert werden kann — deshalb in `auction_details`. **Bitte kurz
  bestätigen.**
- **`title` bleibt auf `auctions`** (Listing-Überschrift, beim Crawl ohne
  Dokumenten-Parsing bekannt, wird für Auflistungen gebraucht) — nicht explizit
  vom Nutzer entschieden, aber analog zu den anderen Identitäts-Feldern.
- **Wie geht `country-rebuild.ts` künftig mit kaputten Crawler-Bugs um**, wenn
  `auctions` nie mehr gelöscht wird? (Bisher war "Land wipen + neu crawlen" der
  Recovery-Weg für z.B. die mv-zvgcom-Triplikation oder den BG-Zapori-Erstlauf-
  Bug.) Empfehlung in diesem Plan: `rebuildCountry` löscht `auctions` nicht mehr;
  echte Korrektur läuft über den normalen Re-Crawl-Upsert (aktualisiert
  `auction_date_iso`/`status`) plus bei Bedarf einen erzwungenen Reprocess (neue
  `auction_details`-Version auf denselben/aktuellen Artefakten). Für echten
  Datenmüll durch falsch geparste `external_id`s gibt es dann keinen
  automatischen Weg mehr — nur ein manuelles, seltenes Cleanup-Skript. **Das ist
  ein echter Kompromiss, den der Nutzer im Gespräch nicht abschließend
  entschieden hat — vor WP-7 nochmal ansprechen.**
- **"Aktueller Stand"-Lesezugriff auf `auction_details`** (für Suche/Karten-
  Filter) läuft über `SELECT DISTINCT ON (platform, external_id) * FROM
  auction_details ORDER BY platform, external_id, version DESC` gestützt durch
  den Index `idx_auction_details_identity_version` — bewusst keine
  `is_current`-Flag-Spalte (würde ein UPDATE auf alte Zeilen erfordern, verletzt
  "nie überschreiben"). Falls das bei echten Datenmengen zu langsam wird: eine
  separate, kleine Pointer-Tabelle `(platform, external_id) → aktuelle
  auction_details.id` nachrüsten, die bei jedem neuen `auction_details`-Insert
  mitgeschrieben wird (reines Zeiger-Update, keine Historiendaten betroffen).
- **Changed-Detection vor neuer `auction_details`-Version:** ein neuer
  Reprocess-Lauf soll nur dann eine neue Version anlegen, wenn sich die
  extrahierten Werte tatsächlich vom aktuellen Stand unterscheiden — sonst
  bläht jeder Enrich-Zyklus die Historie sinnlos auf. Vor dem Insert die neuen
  Werte gegen die aktuell neueste Version vergleichen (analog dem
  Change-only-Prinzip, das `artifact_versions`/`archiveAuction` heute schon für
  Dokumente anwenden).
- **`auction_details.version`-Vergabe muss atomar sein:** `runEnrich`,
  `runReprocess` und `runLlmBatchPoll` können für dieselbe `(platform,
  external_id)` konkurrierend schreiben. Ein einfaches `SELECT MAX(version)`
  gefolgt von einem separaten `INSERT` in `writeAuctionDetails(...)` kann bei
  zwei gleichzeitigen Läufen dieselbe nächste Versionsnummer berechnen und
  kollidieren (oder — schlimmer, ohne den `UNIQUE (platform, external_id,
  version)`-Constraint — eine Version stillschweigend überschreiben/doppeln).
  Der `UNIQUE`-Constraint aus der DDL fängt echte Kollisionen als Fehler ab,
  ersetzt aber keine Serialisierung: `writeAuctionDetails(...)` muss
  MAX(version)+1-Berechnung und INSERT in einer Transaktion mit
  `pg_advisory_xact_lock(hashtext(platform || ':' || external_id))` (oder
  äquivalent: `SELECT ... FROM auctions WHERE (platform, external_id) = ($1,
  $2) FOR UPDATE` als Sperr-Anker) umschließen, damit konkurrierende Aufrufer
  serialisiert werden statt auf einen `UNIQUE`-Fehler zu laufen. Tests: zwei
  gleichzeitige `writeAuctionDetails(...)`-Aufrufe für dieselbe Auktion müssen
  Version N und N+1 erzeugen (nie zweimal N, kein Fehler), plus ein Test für
  das Changed-Detection-Verhalten bei identischen Werten.

### Historische Arbeitspakete (nicht ausführen)

**WP-0 — Umbenennung (mechanisch, kein Verhaltenswechsel)**
- `schema.sql`: idempotente `RENAME TABLE`-Statements für `raw_blobs` →
  `artifact_blobs`, `raw_captures` → `artifact_captures`, `raw_document_sets` →
  `artifact_versions`, `raw_document_set_items` → `artifact_version_items` —
  im selben `DO $$ ... IF EXISTS ... THEN ALTER TABLE ... RENAME TO ... END IF;
  END $$;`-Stil wie der bestehende Terminologie-Rename-Block (schema.sql
  Zeilen ~209-253). FK-Constraints bleiben beim Rename automatisch intakt
  (Postgres bindet an OID, nicht an den Namen).
- `server/utils/raw-archive.ts`: alle SQL-Tabellennamen aktualisieren.
- Grep nach `raw_blobs|raw_captures|raw_document_sets|raw_document_set_items`
  über den ganzen Server-Code (u.a. Admin-Archiv-Browser-Endpunkte,
  `country-rebuild.ts`, Tests) — jede Fundstelle mitziehen.
- Verifikation: `grep -r "raw_blobs\|raw_document_sets" server/` findet nur noch
  den Rename-Block selbst; volle Testsuite grün.

**WP-1 — `auctions` wird echte, früh angelegte Identität**
- `server/utils/current-auctions.ts`: neue Funktion `ensureAuctionIdentity(
  auctions: Auction[])` — `INSERT ... ON CONFLICT (platform, external_id) DO
  NOTHING`, nur Identitäts-/Terminfelder (siehe DDL oben). Bestehendes
  `upsertCurrentAuctions` bleibt vorerst unangetastet (wird erst in WP-6
  zurückgebaut).
- `server/tasks/refresh.ts`: `ensureAuctionIdentity(result.auctions)` direkt
  nach `writeListCache(...)`, vor der `archiveAuction`-Schleife aufrufen.
- `server/utils/country-rebuild.ts`: dieselbe Reihenfolge im Crawl-Loop von
  `rebuildCountry()`. `DELETE FROM auctions WHERE country = $1` aus
  `deleteCountryCurrentData()` entfernen (siehe "Offene Punkte" oben) —
  ansonsten würde die FK unten das sofort mit einem Fehler quittieren, sobald
  `artifact_versions`/`auction_details`-Zeilen existieren.
- schema.sql: FK `artifact_captures`/`artifact_versions` → `auctions` ergänzen
  (siehe DDL), dabei `country`/`region`/`authority`/`case_number` von beiden
  Tabellen droppen (waren nur denormalisiert, weil es vorher keinen
  verlässlichen Anker gab — siehe DDL-Kommentar) sowie die dadurch obsoleten
  Indizes (`idx_capt_az_time`, `idx_capt_country_region_time` auf
  `artifact_captures`; `idx_doc_sets_country_region_time` auf
  `artifact_versions`).
- **Historische Vorsicht, bewusst gegengecheckt:** Genau dieses "region per
  JOIN gegen `auctions` statt eigener Spalte" war schon einmal kaputt (siehe
  schema.sql-Kommentar zum "Roh-Archiv-Fix" von 2026-07-3x) — damals wurde
  `auctions` bei jedem `enrich`-Lauf komplett neu geschrieben, ein
  fehlgeschlagener Upsert-Chunk konnte ein ganzes Bundesland im Archiv-Browser
  verschwinden lassen, deshalb wurde `region` doch wieder direkt auf
  `raw_captures` gespeichert. Der Grund dafür entfällt erst durch WP-1 selbst:
  `auctions` wird jetzt beim allerersten Crawl geschrieben (nicht mehr spät von
  `enrich.ts`) und nie gelöscht — der JOIN ist danach robuster als beim ersten
  Anlauf. Trotzdem: Admin-Archiv-Browser-Endpunkte (`regions.get.ts`/
  `cases.get.ts` o.ä.), die heute direkt aus `raw_captures`/`raw_document_sets`
  lesen, müssen auf einen JOIN gegen `auctions` umgestellt werden — nicht
  vergessen, sonst brechen sie beim Spalten-Drop.
- Verifikation: zweifacher `refresh`-Lauf für ein Land → `auctions`-Zeile
  entsteht bereits nach dem ersten Lauf, vor jedem `enrich`. Manuelles Löschen
  einer referenzierten `auctions`-Zeile schlägt mit FK-Fehler fehl (Beweis,
  dass die Reihenfolge jetzt erzwungen ist). Archiv-Browser liefert nach der
  Umstellung identische Land/Region-Navigation wie vorher.

**WP-2 — verworfener additiver Dual-Write-Plan (nicht ausführen)**
- schema.sql: `CREATE TABLE auction_details` (siehe DDL).
- Neues Modul `server/utils/auction-details.ts` (Vorbild: `extraction-cache.ts`/
  `auction-snapshot.ts`): `writeAuctionDetails(...)` (immer INSERT einer neuen
  Version, nie UPDATE, mit Changed-Detection und atomarer Versionsvergabe per
  Advisory-Lock — siehe "Offene Punkte"),
  `readLatestAuctionDetails(platform, externalId)`, `readAuctionDetailsAtVersion
  (platform, externalId, version)`, In-Memory-Cache + `invalidate...()` im
  bestehenden Muster.
- `enrich.ts`/`reprocess.ts`/`llm-batch-poll.ts`: zusätzlich (nicht ersetzend)
  `writeAuctionDetails(...)` aufrufen, neben den bestehenden
  `writeExtractionCache`/`writeAuctionSnapshot`-Aufrufen — bewusst
  Dual-Write, damit dieses WP für sich genommen risikofrei/rückwärtskompatibel
  bleibt (nichts liest `auction_details` noch).
- Einmaliges Backfill-Skript (nicht Teil von `schema.sql`s Boot-Migration, da
  historisch/einmalig): für jede bestehende `(platform, external_id)` aus
  `extraction_cache.extraction` + `auction_snapshot.auction` eine
  `auction_details`-Zeile mit `version = 1` erzeugen, `artifact_version_id` auf
  die jeweils neueste vorhandene `artifact_versions`-Zeile setzen (oder `NULL`,
  falls keine existiert). `extracted_at` aus `AuctionExtraction.at` übernehmen,
  falls im gecachten Objekt vorhanden, sonst `extraction_cache.updated_at` als
  bester verfügbarer Ersatz. Diese Zeile ist ausdrücklich ein Best-Effort-
  Startpunkt, keine exakte Rekonstruktion historischer Provenienz (siehe
  "Explizit nicht Teil dieses Plans").
- Verifikation: Backfill lokal/gegen einen Datenbank-Dump laufen lassen,
  Stichproben gegen die alten `extraction_cache`/`auction_snapshot`-Werte
  gegenchecken. Dual-Write per Test: nach einem `enrich`-Lauf existiert sowohl
  die alte als auch eine neue `auction_details`-Zeile mit identischen Werten.

**WP-3 — Lese-Pfad-Umstellung**
Betroffene Dateien (per Grep verifiziert, Stand 2026-08-01):
`server/api/auction/[platform]/[id].get.ts`,
`server/api/auction/[platform]/[id]/summary.get.ts`,
`server/api/auction/[platform]/[id]/translation.post.ts`,
`server/api/auction/[platform]/[id]/insight/[insightId].post.ts`,
`server/api/auctions.get.ts`, `server/api/auctions-geo.get.ts`,
`server/api/data/v1/auctions.get.ts`,
`server/api/data/v1/auctions/[platform]/[id].get.ts`,
`server/api/lawyer-inquiries/index.post.ts`,
`server/api/settings/llm-batch-jobs.get.ts`,
`server/utils/auction-search-filters.ts`.
- Alle auf `auctions JOIN auction_details` (neueste Version, per `DISTINCT ON`
  + Index, siehe "Offene Punkte") umstellen statt `extraction_cache`/
  `auction_snapshot`/den heutigen Objekt-Spalten auf `auctions` zu lesen.
- `auction-search-filters.ts`: WHERE-Klausel-Builder auf `auction_details`-
  Spalten umstellen (Land/Region-Filter bleiben auf `auctions`, Fläche/
  Zimmer/Preis/Baujahr wandern zu `auction_details`).
- Verifikation: bestehende API-Tests (`*.get.test.ts`) weiterhin grün nach
  Umstellung der Fixtures auf das neue Schema; manueller Vergleich eines
  Suchergebnisses vor/nach der Umstellung (gleiche Treffer, gleiche Filterwerte).

**WP-4 — `auction_translations` versionieren**
- `server/utils/content-translation.ts`: `version`-Parameter durch
  `readAuctionTranslation`/`claimAuctionTranslation`/`completeAuctionTranslation`/
  `failAuctionTranslation` durchreichen.
- `server/api/auction/[platform]/[id]/translation.post.ts`: übergibt die
  aktuell neueste `auction_details.version`.
- Backfill: bestehende `auction_translations`-Zeilen bekommen `version = 1`.
- Verifikation: Übersetzungsanfrage für Version 1 abgeschlossen, dann neue
  `auction_details`-Version 2 mit geänderter Beschreibung erzeugt → neue
  Übersetzungsanfrage für Version 2 liefert neuen Inhalt, Version-1-Übersetzung
  bleibt unverändert abrufbar.

**WP-5 — `location_enrichment`-FK**
- schema.sql: FK ergänzen (trivial, da `auctions` durch WP-1 garantiert
  vorher existiert).
- `server/utils/auction-details.ts`s Writer (aus WP-2, sowie `ensureAuctionIdentity`
  aus WP-1 für neue Auktionen): beim Schreiben einer neuen Version mit spürbar
  geändertem `lat`/`lng` gegenüber der bisher neuesten Version einen
  gezielten, detachten Aufruf `runExternalEnrichment({ platform, externalId })`
  auslösen (siehe Punkt 8 oben) — nicht auf den nächtlichen Cron-Sweep warten,
  der bleibt unverändert für die extern-datensatzseitige Aktualität bestehen.

**WP-6 — Contract: alte Tabellen/Spalten entfernen**
- **Erledigt per direktem Cutover:** `extraction_cache`, `auction_snapshot`,
  ihre Module, Backfill-Skripte und Legacy-Fallbacks sind entfernt. Die
  Objekt-/Preisspalten wurden aus `auctions` entfernt und
  `current-auctions.ts` schreibt nur noch Identitäts-/Terminfelder.

**WP-7 — `country-rebuild.ts` neu zuschneiden**
- **Erledigt:** Ein expliziter Länder-Rebuild löscht List-Cache,
  Beobachtungen, Übersetzungen, Details/Fotos, Fetch-/Location-State,
  Artefakte und Auktionsidentitäten des Landes. Danach werden Identitäten und
  Rohdaten aus dem Crawl neu aufgebaut; Enrich/Reprocess füllen den Rest.

### Historisch nicht eingeplante Arbeiten

- Rückwirkende Migration/Backfill von Daten, die vor diesem Umbau schon
  unwiederbringlich überschrieben wurden (z.B. frühere `auctions`-Stände) —
  die Versionshistorie beginnt ab WP-2, nicht rückwirkend.
- Automatisches Cleanup-Tooling für die in "Offene Punkte" genannten
  Datenmüll-Fälle (falsch geparste `external_id`s) — falls gebraucht, eigener
  Folge-Plan.
- Änderungen an der S3-Speicherschicht selbst (`artifact_blobs`/Outbox/Backup)
  — die bleibt unverändert, nur der Tabellenname ändert sich.
