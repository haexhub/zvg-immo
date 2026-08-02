# Auction-Details-Vervollständigung — Nachtrag zum Identity-Redesign

**Status (2026-08-02): Design fertig diskutiert, KEIN Code geschrieben.** Nachtrag
zu `docs/plans/2026-08-01-auction-identity-schema-redesign.md` (WP-0…WP-7).
Setzt WP-0…WP-5 als gemergt voraus. Umsetzung wieder **pro Arbeitspaket in
einem eigenen Worktree**, nicht als ein großer Umbau.

## Wie es dazu kam

WP-3 (PR #296) stellte den Lese-Pfad für die SQL-Suchabfragen erfolgreich auf
`auction_details` um, blieb aber bei sieben Endpunkten bewusst stehen:
`server/api/auction/[platform]/[id].get.ts`, `…/[id]/translation.post.ts`,
`…/[id]/insight/[insightId].post.ts`, `server/api/data/v1/auctions.get.ts`,
`server/api/data/v1/auctions/[platform]/[id].get.ts`,
`server/api/lawyer-inquiries/index.post.ts`,
`server/api/settings/llm-batch-jobs.get.ts`. Sie lesen keine einzelnen SQL-
Spalten, sondern vollständige `Auction`/`AuctionExtraction`-Objekte, und ein
Teil der dafür nötigen Felder hat in `auction_details` bewusst kein Zuhause,
weil sie keine Extraktions*ergebnisse* sind, sondern anderer Natur — das war
zum Zeitpunkt von WP-3 eine offene Frage, keine Design-Entscheidung.

Diese Frage wurde in der Session nach WP-0…5 durchgesprochen. Ergebnis: die
fehlenden Felder sind **drei grundverschiedene Arten von Daten**, keine, die
eine gemeinsame Lösung teilen:

1. **Crawl-Rohdaten**, die den Archivierungslauf erst antreiben (`attachments`
   treibt `prepareLiveLlmDocuments()` in `enrich.ts` — sie müssen existieren,
   *bevor* irgendeine `artifact_*`-Zeile entsteht, können also nicht aus dem
   Archiv gelesen werden).
2. **Extraktions-Output**, der wie die schon vorhandenen `auction_details`-
   Spalten bei jedem Enrich-Lauf neu geschrieben wird (belegt durch den
   Catch-all-Pass aus WP-2, der `writeAuctionDetails` bei *jedem* Lauf
   aufruft, nicht nur bei neuen Dokumenten).
3. **Pipeline-Betriebszustand** (Retry-Zähler, In-Flight-Marker) — reines
   Scratch-State, das bei jedem Versuch überschrieben wird, keine Historie.

Ein vierter Fund dabei: vier Felder (`documentSetHash`/`documentSetVersion`/
`archivedDocumentSetHash`/`archivedDocumentSetVersion`) lösten bisher ein
Problem, das WP-0/WP-1 bereits strukturell gelöst haben — sie sind
voraussichtlich nicht zu migrieren, sondern zu **streichen** (siehe unten).

## Zielarchitektur — Übersicht

| Herkunft (heute) | Ziel | Rolle |
|---|---|---|
| `Auction.attachments`/`pdfUrl(Upstream)`/`detailUrl(Upstream)`/`photoUrls`/`sourceUpdatedIso`/`detailFetchedAt`, `AuctionExtraction.llmBatchJob`/`llmFailures`/`photosCheckedAt`/`photoFailures`/`photoPipelineVersion` | **`auction_fetch_state`** (neu) | Mutabler, unversionierter Ist-Zustand pro Auktion. `UPDATE` statt `INSERT`, FK auf `auctions`. Analog zu `location_enrichment`. |
| `AuctionExtraction.photos` (`CuratedPhoto[]`) | **`auction_photos`** (neu) | Kuratierte Fotos, 1:n, versioniert über `auction_details.id` (Kuratierung kann sich bei Reprocess ändern). |
| `Auction.sourceLivingAreaSqm`/`sourceLandAreaSqm`/`sourceRooms`, `AuctionExtraction.marketValueText` | **`auction_details`** (Spalten ergänzt) | Läuft im selben Enrich-Rhythmus wie die schon vorhandenen Spalten dort. |
| `Auction.auctionDateText` | **`auctions`** (Spalte ergänzt) | Roh-Text-Zwilling von `auction_date_iso`, das schon auf `auctions` liegt — kein eigener Rhythmus. |
| `AuctionExtraction.documentSetHash`/`documentSetVersion`/`archivedDocumentSetHash`/`archivedDocumentSetVersion` | **entfällt** | Ersetzt durch einen direkten Vergleich `artifact_versions` (neueste Version) gegen `auction_details.artifact_version_id` (siehe unten). |

## Warum die vier Hash-Felder entfallen, nicht migrieren

`enrich.ts` (archiviert Dokumente) und `reprocess.ts` (parst sie) laufen
unabhängig und kommunizierten bisher nur über die gemeinsame
`extraction_cache`-Zeile: `archivedDocumentSetHash`/`-Version` ist, was
`enrich.ts` zuletzt archiviert hat, `documentSetHash`/`-Version` ist, was
`reprocess.ts` zuletzt geparst hat — ein Vergleich der beiden entscheidet,
ob Reprocessing fällig ist (`server/tasks/reprocess.ts:211-212`).

Das war nötig, weil es vorher keine einzige verlässliche Versions-Quelle für
den Dokumentbestand gab. Nach WP-0/WP-1 gibt es die: `artifact_versions`
trägt `version` **und** `set_hash` bereits als Spalten, und
`auction_details.artifact_version_id` hält fest, welches Manifest zuletzt
ausgewertet wurde. Reprocessing ist fällig, wenn

```sql
SELECT max(version) FROM artifact_versions WHERE platform = $1 AND external_id = $2
```

größer ist als die `artifact_versions.version` des Manifests, auf das die
neueste `auction_details`-Zeile zeigt — derselbe Vergleich, ohne die vier
Felder redundant mitzuführen. Das ist eine echte Vereinfachung, keine reine
Verschiebung: weniger Felder in `AuctionExtraction`, weniger Stellen in
`enrich.ts`/`reprocess.ts`, die synchron gehalten werden müssen.

## Datenmodell (Ziel-DDL)

```sql
-- auction_fetch_state: mutabler Ist-Zustand pro Auktion, keine Historie.
-- Wird bei jedem Crawl/Enrich-Lauf überschrieben, nie versioniert — das
-- unterscheidet sie von auction_details.
CREATE TABLE IF NOT EXISTS auction_fetch_state (
  platform              text NOT NULL,
  external_id           text NOT NULL,
  pdf_url               text,
  pdf_url_upstream      text,
  detail_url            text,
  detail_url_upstream   text,
  attachments           jsonb NOT NULL DEFAULT '[]'::jsonb,  -- Attachment[]
  photo_urls            text[],
  source_updated_iso    timestamptz,
  detail_fetched_at     timestamptz,
  llm_batch_job         text,
  llm_failures          integer NOT NULL DEFAULT 0,
  photos_checked_at     timestamptz,
  photo_failures        integer NOT NULL DEFAULT 0,
  photo_pipeline_version integer,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, external_id),
  FOREIGN KEY (platform, external_id) REFERENCES auctions (platform, external_id)
);

-- auction_photos: kuratierte Fotos, versioniert über auction_details (die
-- Kuratierung — Kategorie/Reihenfolge/isPropertyPhoto — ist LLM-/Regel-
-- Output, kann sich bei einem Reprocess ändern wie jedes andere
-- Extraktionsfeld). Kein FK auf artifact_blobs: die Bilddateien liegen im
-- separaten Foto-Bucket (server/utils/image-storage.ts), nicht im
-- Content-adressierten Dokumentenarchiv — es gibt keinen Blob-Bezug, der
-- sich sauber referenzieren ließe.
CREATE TABLE IF NOT EXISTS auction_photos (
  id                  bigserial PRIMARY KEY,
  auction_details_id  bigint NOT NULL REFERENCES auction_details (id) ON DELETE CASCADE,
  ordinal             integer NOT NULL,
  file                text NOT NULL,
  category            text NOT NULL,
  caption             text,
  is_property_photo   boolean NOT NULL,
  UNIQUE (auction_details_id, ordinal)
);

-- auction_details: vier Spalten ergänzt. Laufen im selben Enrich-Rhythmus
-- wie die schon vorhandenen Spalten (siehe "Wie es dazu kam").
ALTER TABLE auction_details ADD COLUMN IF NOT EXISTS source_living_area_sqm numeric;
ALTER TABLE auction_details ADD COLUMN IF NOT EXISTS source_land_area_sqm numeric;
ALTER TABLE auction_details ADD COLUMN IF NOT EXISTS source_rooms numeric;
ALTER TABLE auction_details ADD COLUMN IF NOT EXISTS market_value_text text;

-- auctions: eine Spalte ergänzt, direkt neben auction_date_iso (derselbe
-- Fakt, nur als Roh-Text statt strukturiert — kein eigener Rhythmus, kein
-- eigenes Zuhause nötig).
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS auction_date_text text;
```

## Im Gespräch geklärte Entscheidungen (nicht erneut aufrollen)

1. **`sourceLivingAreaSqm`/`sourceLandAreaSqm`/`sourceRooms` gehören auf
   `auction_details`, nicht auf `auctions`.** Ursprünglich anders eingeordnet
   (Annahme: "ändert sich nur mit neuen Dokumenten"), aber der Catch-all-Pass
   aus WP-2 (`enrich.ts`, schreibt `auction_details` bei jedem Lauf neu, nicht
   nur bei neuen Dokumenten) zeigt: die Trennlinie zwischen `auctions` und
   `auction_details` ist nicht "Dokument vs. kein Dokument", sondern
   "Identität vs. Enrich-Ergebnis". Diese drei Felder laufen im
   Enrich-Rhythmus, also gehören sie daneben.
2. **`photos` wird eine eigene Tabelle, kein `jsonb`-Array auf
   `auction_details`.** Anders als `condition`/`insights`/`extraction_texts`
   (freie LLM-Einschätzung ohne Bezug zu anderen Zeilen) hat jedes kuratierte
   Foto eine konkrete Datei-Referenz — saubere 1:n-Modellierung statt
   Array-im-JSON.
3. **`auction_fetch_state` bündelt zwei konzeptionell unterschiedliche
   Feldgruppen** (Crawl-URLs/Attachments und Pipeline-Retry-Zähler) in einer
   Tabelle, weil beide dieselbe strukturelle Eigenschaft teilen: mutabel,
   unversioniert, kein Bezug zu einer bestimmten Extraktions-Version. Siehe
   "Offene Punkte" — das ist Bequemlichkeit, kein zwingender Grund.
4. **Kein FK von `auction_photos` auf `artifact_blobs`.** Kuratierte Fotos
   liegen in einem separaten, nicht Content-adressierten Speicher
   (`.cache_zvg/images` lokal, gespiegelt in einen eigenen Supabase-Bucket via
   `image-storage.ts`) — anders als Dokumente/PDFs, die über
   `artifact_blobs`/`artifact_version_items` laufen. Es gibt keine
   gemeinsame Identität, die sich referenzieren ließe.
5. **Die vier Hash-Tracking-Felder werden gestrichen, nicht migriert** — siehe
   eigener Abschnitt oben. Das ist der einzige Teil dieses Nachtrags, der
   bestehendes Verhalten *vereinfacht* statt nur verschiebt.

## Offene Punkte — vom planenden Modell entschieden, NICHT explizit vom Nutzer
bestätigt. Bei Umsetzung kurz gegenchecken, nicht blind übernehmen:

- **Eine `auction_fetch_state`-Tabelle statt zwei.** Crawl-Staging (URLs,
  Attachments) und Pipeline-Retry-Bookkeeping (`llmFailures`,
  `photoFailures`, ...) sind inhaltlich verschiedene Sorgen, die nur zufällig
  dieselbe strukturelle Form haben (mutabel, unversioniert). Eine Tabelle
  spart eine FK-Beziehung und einen JOIN; zwei Tabellen wären fachlich
  sauberer getrennt (unterschiedliche Schreibpfade: Crawler schreibt URLs,
  `enrich.ts`s Foto-/LLM-Pipeline schreibt die Zähler). Für die Größenordnung
  dieses Projekts hier als eine Tabelle vorgeschlagen — bei Bedarf leicht zu
  splitten.
- **`attachments` bleibt `jsonb`, `photo_urls` bleibt `text[]`** — beide
  ändern sich nicht in einer Weise, die SQL-Diffing zwischen Ständen bräuchte
  (kein Versionsverlauf für diese Tabelle), analog zur `jsonb`-Begründung im
  Ursprungsplan.
- **`llm_batch_job` bleibt ein loser Text-Zeiger** (kein FK auf
  `llm_batch_jobs.job_name`) — die bestehende Semantik ist "Marker, der nach
  48h als verwaist gilt", kein referenzielles Muss. Ein FK würde beim
  Löschen/Ablaufen eines Batch-Jobs zusätzliche Aufräum-Logik erzwingen, ohne
  einen praktischen Nutzen zu bringen.
- **`market_value_text` landet nur auf `auction_details`, nicht zusätzlich
  auf `auctions`** — anders als `title`, das beim reinen Crawlen ohne
  Dokumenten-Parsing bekannt ist, kommt der Markwert-Text ausschließlich aus
  der LLM-Extraktion des Gutachtens.

## Server-seitige Änderungen, gruppiert nach Arbeitspaket

**WP-8 — `auction_fetch_state` einführen, vier Hash-Felder streichen**
- `schema.sql`: `CREATE TABLE auction_fetch_state` (siehe DDL).
- Neues Modul `server/utils/auction-fetch-state.ts`
  (`writeAuctionFetchState(...)` — immer `UPDATE`/`UPSERT`, kein Versions-
  Zähler; `readAuctionFetchState(platform, externalId)`).
- `enrich.ts`: schreibt `auction_fetch_state` zusätzlich zu den bestehenden
  `Auction`-Feldern (Dual-Write, wie WP-2 es für `auction_details` vorgemacht
  hat).
- `enrich.ts`/`reprocess.ts`: Staleness-Vergleich auf `artifact_versions` vs.
  `auction_details.artifact_version_id` umstellen (siehe eigener Abschnitt
  oben), `documentSetHash`/`documentSetVersion`/`archivedDocumentSetHash`/
  `archivedDocumentSetVersion` aus `AuctionExtraction` entfernen.
- Verifikation: nach einem Enrich-Lauf existiert eine `auction_fetch_state`-
  Zeile mit identischen Werten zu den `Auction`-Feldern. Ein zweiter Lauf mit
  neuen `artifact_versions` löst Reprocessing aus, einer ohne nicht — geprüft
  ohne die vier gestrichenen Felder.

**WP-9 — `auction_photos` einführen**
- `schema.sql`: `CREATE TABLE auction_photos` (siehe DDL).
- `server/utils/auction-details.ts` (oder neues `auction-photos.ts`):
  `writeAuctionPhotos(auctionDetailsId, photos: CuratedPhoto[])`, aufgerufen
  direkt nach `writeAuctionDetails` mit der zurückgegebenen `id` — nur bei
  `changed: true` (sonst keine neue `auction_details`-Zeile, an die sich
  Fotos hängen ließen).
- Verifikation: Reprocess mit geänderter Fotokuratierung erzeugt neue
  `auction_photos`-Zeilen unter der neuen `auction_details_id`, alte Version
  bleibt unverändert abrufbar (Historie).

**WP-10 — `auction_details`/`auctions` um die verbleibenden Spalten ergänzen**
- `schema.sql`: vier `ALTER TABLE auction_details ADD COLUMN`, eine
  `ALTER TABLE auctions ADD COLUMN` (siehe DDL).
- `server/utils/auction-details.ts`: `auctionDetailsValues(...)` um die vier
  Felder ergänzen.
- `server/utils/current-auctions.ts`: `ensureAuctionIdentity`/
  `upsertCurrentAuctions` um `auction_date_text` ergänzen.
- Verifikation: analog WP-2s Dual-Write-Test, für die vier neuen Spalten.

**WP-11 — WP-3 abschließen: die sieben verbliebenen Endpunkte umstellen**
- Die sieben Dateien aus WP-3s "Not migrated"-Liste auf
  `auctions JOIN auction_details JOIN auction_fetch_state [JOIN auction_photos]`
  umstellen statt `readAuctionSnapshot()`/`readExtractionCache()`.
- `buildContentHashInput(auction)`/`auctionTranslationContentHash(auction)`/
  `toPublicAuction(auction)` (und was sie sonst noch konsumieren) auf die
  neue Feldherkunft umstellen.
- `llm-batch-jobs.get.ts` liest `llm_batch_job`/`llm_failures` jetzt aus
  `auction_fetch_state` statt aus dem Cache-Blob.
- Verifikation: bestehende API-Tests dieser sieben Endpunkte weiterhin grün
  nach Umstellung der Fixtures. Das schließt WP-3 endgültig ab und macht
  WP-6 (Contract: `extraction_cache`/`auction_snapshot` droppen) erstmals
  planbar — WP-6 selbst bleibt weiterhin auf Prod-Burn-in gegated, siehe
  Ursprungsplan.

## Explizit nicht Teil dieses Plans

- WP-6/WP-7 aus dem Ursprungsplan — dieser Nachtrag macht WP-6 planbar,
  implementiert es aber nicht.
- Rückwirkendes Backfill von `auction_fetch_state`/`auction_photos` für
  historische, bereits archivierte Auktionen — beide Tabellen sind reiner
  Ist-Zustand; ein Backfill aus `extraction_cache`/`auction_snapshot` ist
  möglich (analog zu WP-2s `backfill-auction-details.ts`), aber nicht in
  diesem Dokument spezifiziert. Bei Bedarf als eigenes Backfill-Skript in
  WP-8/WP-9.
- Eine mögliche Aufteilung von `auction_fetch_state` in zwei Tabellen (siehe
  "Offene Punkte") — falls gewünscht, vor WP-8 klären, nicht währenddessen.
