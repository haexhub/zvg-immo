# Admin-Technikseite pro Auktion + LLM-Modellvergleich

Stand: 2026-08-08 · Status: WP-0 + WP-1 gemergt (PR #368), WP-7 umgesetzt, WP-2 bis WP-6 offen

## Ziel

Für den Admin eine technische Detailseite pro Auktion/Anzeige, die zeigt, wie
Crawling, Dokumentenextraktion, LLM-Analyse und externe Datenanreicherung
gelaufen sind — inklusive Fehlern und fehlenden Daten. Dieselben Informationen
werden aus der öffentlichen Objektansicht entfernt.

Auf derselben Seite: eine Auktion gezielt mit einem **auswählbaren** LLM-Profil
neu extrahieren lassen, ohne die öffentlich sichtbare Version zu verändern.
Ergebnisse mehrerer Modelle bleiben nebeneinander erhalten, sind gegeneinander
diffbar, eine davon kann manuell live geschaltet werden, alte/überflüssige
Versionen können gelöscht werden.

## Entscheidungen (mit dem Nutzer abgestimmt, 2026-08-08)

1. **Experimente sind Trial-Versionen.** Ein Admin-Lauf schreibt eine Version,
   die *nicht* live geht. Live-Schaltung ist eine explizite Aktion.
2. **Aus der öffentlichen Ansicht fliegen nur Pipeline-Interna** (Analyse-Badge,
   Extraktionshinweis mit Konfidenz). Quellen-Attributionen
   („Quelle: BORIS, geprüft am …") bleiben — Copernicus/EFFIS, DVF und EEA
   verlangen Namensnennung.
3. **Route `/admin/auktion/[platform]/[id]`**, verlinkt von der Objektseite.
   Nicht `/settings/auktion/…`: `pages/settings.vue` plus ein Verzeichnis
   `pages/settings/` erzeugt in Nuxt verschachtelte Routen, deren Parent
   `<NuxtPage/>` rendern müsste. Die APIs liegen trotzdem unter
   `/api/settings/*`, weil nur dieser Präfix vom Guard in
   `server/middleware/settings-auth.ts` geschützt wird.

## Ausgangslage

Zeilenangaben in diesem Dokument stehen auf dem Stand nach PR #368.

| Befund | Konsequenz |
|---|---|
| `auction_details` ist bereits append-only versioniert (`server/db/schema/core.ts:171`) — jeder geänderte Lauf hängt eine `version` an, `is_latest` markiert die aktuelle | Die Historie existiert schon; es fehlen Provenienz und UI. |
| ~~Kein Modell/Profil wird pro Version gespeichert~~ — **erledigt in WP-1**: `llm_provider`, `llm_model`, `llm_profile_id`, `run_trigger`, `llm_duration_ms` stehen neben `extraction_source`/`extraction_confidence`/`llm_analyzed_at` | Versionen sind einem Modell zuzuordnen, sofern der Lauf über `runReprocess` kam (Lücken s. WP-1). |
| ~~Vier Lesepfade wählen „die aktuelle Version" per `ORDER BY version DESC LIMIT 1`~~ — **erledigt in WP-0**: `server/utils/auction-record.ts:129`, `server/utils/auction-details.ts:263`, `server/api/auctions.get.ts:79`, `server/utils/artifact-version-state.ts:61` lesen jetzt `is_latest` | Trial-Versionen schlagen nicht mehr öffentlich durch. |
| `POST /api/settings/reprocess` kann bereits auf `platform`+`externalId` scopen | Einzellauf ist zu 80 % vorhanden; es fehlt „mit *diesem* Profil". Das Extraktions-LLM wird heute global aus den Assignments aufgelöst (`server/utils/extract/llm-task-config.ts:24`). |
| `task_run_errors` speichert Fehler pro Auktion, aber nur `enrich.ts` schreibt dorthin; `reprocess.ts` loggt nur nach stdout (`server/tasks/reprocess.ts:923`) | „Wo gab es Fehler" ist für den gesamten LLM-Zweig aktuell nicht beantwortbar. |

## WP-0 · Trial-Versionen tragfähig machen — ERLEDIGT (PR #368)

Fundament, muss vor WP-4 liegen.

1. Migration `0009_tense_wolverine.sql`: `auction_details.is_trial boolean not
   null default false`.
2. Die vier Lesepfade oben auf `WHERE ad.is_latest` umgestellt. Nutzt den
   vorhandenen Partial-Index `idx_auction_details_latest` und ist nebenbei
   schneller als der `ORDER BY version DESC`-LATERAL-Join.
3. `writeAuctionDetails` (`server/utils/auction-details.ts:329`) hat
   `options.trial`:
   - Trial-Insert setzt `is_latest = false` und degradiert die bisherige
     Live-Zeile **nicht**.
   - Trial-Insert überspringt den Unchanged-Check. Wenn Modell B dasselbe
     liefert wie Modell A, ist genau das ein Messergebnis.
   - Trial-Zeilen landen nicht im `latestCache` — sonst würde
     `readLatestAuctionDetails` das Experiment ausliefern.
   - `version` bleibt global `max(version)+1`, sonst kollidiert der UNIQUE.
   - Die „previous latest"-Ermittlung für normale Schreibvorgänge läuft jetzt
     ebenfalls über `is_latest` statt `max(version)`, sonst degradiert ein
     Cron-Lauf eine Trial-Zeile statt der Live-Zeile.

**Nachgezogen im Review:** `deleteRawArchiveCountry` cascadet über
`fk_auction_details_artifact_version` in `auction_details`, erwischt dabei aber
nur Versionen **mit** `artifact_version_id`. Nahm die Kaskade die
`is_latest`-Zeile und ließ eine listing-only Version (`NULL`, von `enrich.ts`)
stehen, blieb die Identität ohne Live-Zeile zurück — mit den umgestellten
Lesepfaden liefert die Auktion dann leere Details statt der älteren Version, und
das heilt nur durch erneutes Crawlen **und** Reprocessing. Die neueste
überlebende Nicht-Trial-Version wird jetzt in derselben Transaktion nachgezogen
(`server/utils/raw-archive-delete.ts:153`). **Dieselbe Invariante gilt für jeden
künftigen Schreiber:** wo `auction_details`-Zeilen gelöscht werden, muss
danach genau eine `is_latest`-Zeile pro Identität übrig bleiben — relevant für
WP-5s Delete-Endpoint.

**Verifiziert:** `describeDb`-Tests in `server/utils/auction-details.test.ts`
(Trial bleibt für `readLatestAuctionDetails` unsichtbar; normaler Lauf nach einer
Trial vergleicht/degradiert gegen die Live-Zeile) und in
`server/utils/raw-archive-delete.test.ts` (Kaskade nimmt die Live-Zeile → älteste
überlebende Version wird live; ist sie ein Trial → bleibt sie es nicht). Beide
gegen einen frischen `supabase/postgres`-Container mit `pnpm db:migrate`.

**Offen:** `readLatestAuctionDetails` hat außer Tests keinen Aufrufer — einer der
„vier Lesepfade" ist toter Code. Vor WP-2 entscheiden, ob der Endpoint ihn nutzt
oder die Funktion wegfällt.

## WP-1 · Provenienz pro Version — ERLEDIGT (PR #368)

Migration `0009_tense_wolverine.sql` + Schreibpfad: `llm_provider`, `llm_model`,
`llm_profile_id`, `run_trigger` (`'cron' | 'manual'`), `llm_duration_ms` auf
`auction_details`.

Bewusst **nicht** in `VALUE_COLUMNS` aufgenommen — sonst mintet ein reiner
Modellwechsel bei identischen Fakten eine Version. Durchgereicht wie
`artifactVersionId` über `WriteAuctionDetailsOptions`; `runReprocess` füllt sie
aus dem tatsächlich verwendeten `LlmConfig` (die Fallback-Kette in
`server/tasks/reprocess.ts:502` gibt ihn als `llmConfigUsed` zurück).
`LlmConfig`/`LlmProviderOverride` tragen dafür ein optionales `profileId`, das
`resolveAssignedProfileChain` setzt.

Zwei Semantik-Punkte, die im Review geschärft wurden und für WP-2s Anzeige
zählen:

- **Provenienz hängt am tatsächlichen Provider-Request, nicht am
  `extractByLlm`-Rückgabewert.** Die Funktion gibt `null` zurück *bevor*
  `onProviderAttempt` feuert, wenn der archivierte Snapshot gar keine Parts
  ergibt (kein Titel, keine Beschreibung, keine Dokumente). Sonst trüge eine
  rules-only-Version Provider/Modell eines Modells, das nie gefragt wurde.
- **`llm_duration_ms` misst nur den Provider-Request.** Vorher lief der Timer um
  den ganzen `reprocessAuction`-Aufruf inklusive `buildReprocessInput` — das
  lädt jeden archivierten Blob neu und rastert gescannte PDF-Seiten, dominiert
  also die Messung und macht Modellvergleiche wertlos.

**Bekannte Lücke:** `llm-batch-poll.ts` schreibt Batch-Ergebnisse ohne
Provenienz und ohne `run_trigger`. Läuft die Extraktion über die Batch-API
(`execution_mode = 'batch'`), bleiben die Spalten `NULL`, obwohl ein LLM lief —
WP-2 muss das als „unbekannt" darstellen statt als „kein LLM", oder WP-1 wird
für den Batch-Pfad nachgezogen. `enrich.ts` und `geocode.ts` schreiben
korrekterweise `NULL`: dort läuft kein LLM.

**Verifiziert:** `pnpm test`. Ein scoped `reprocess`-Lauf gegen eine echte
Auktion steht noch aus.

## WP-2 · Technik-API

`GET /api/settings/auction/[platform]/[id]/technical` — ein Endpoint, ein
Aggregat, alles aus vorhandenen Tabellen:

- **Identität & Geocoding** — `auctions` inkl. `geocode_attempted_at/result/provider`, `first_seen_at`, `updated_at`
- **Crawl/Fetch-Zustand** — `auction_fetch_state`: `detail_fetched_at`, Attachments, `photo_failures`, `photos_checked_at`, `llm_failures`, `llm_last_attempted_at`, `llm_batch_job`
- **Dokumentarchiv** — `artifact_versions` + `artifact_version_items` + `artifact_captures`/`artifact_blobs`. Die Query aus `server/api/settings/archive/documents.get.ts` in ein Util ziehen und von beiden Endpoints nutzen statt zu duplizieren.
- **Extraktionshistorie** — alle `auction_details`-Zeilen mit Version, Zeitstempeln, `is_latest`/`is_trial`, Provenienz aus WP-1 (NULL-Provenienz heißt „unbekannt", nicht „kein LLM" — s. WP-1)
- **LLM-Batch** — `llm_batch_jobs`-Zeilen, deren `custom_id_map` diese Identität enthält, plus Status
- **Fehler** — `task_run_errors` gefiltert auf platform/external_id. Braucht einen neuen Index `(platform, external_id, created_at desc)`; vorhanden ist nur `(task, created_at desc)`.
- **Externe Daten** — `location_enrichment`: pro `COVERAGE_SOURCE_IDS`-Quelle „vorhanden / fehlt", `checkedAt`, `sourceVersion`. Dazu `auction_geo_metrics` (inkl. `features_epoch`, `computed_at`, `point_hash`) und die verknüpfte `climate_cells`-Zeile. Prädikate aus `server/utils/external-data/coverage.ts` als Einzelauktions-Variante wiederverwenden.
- **Übersetzungen** — `auction_translations`-Status je Sprache/Version inkl. `failed_config`

**Verifizieren:** Integrationstest gegen Testcontainer-DB mit einer synthetischen
Auktion; jede Sektion liefert Werte statt `null`.

## WP-3 · Admin-Seite

`pages/admin/auktion/[platform]/[id].vue`.

Auth-Muster wie `pages/settings.vue`: `onMounted` → `/api/settings/session`
proben, sonst Login-Formular. Sektionen als Cards analog `components/settings/*`;
`useSettingsError` und `useSettingsAction` wiederverwenden.

Auf der öffentlichen Objektseite ein dezenter „Technik"-Link, der nur gerendert
wird, wenn die Session-Probe erfolgreich war (clientseitig, kein SSR-Leak).

Neue i18n-Keys unter `settings.auctionTechnical.*` in `de.json` **und** `en.json`.

## WP-4 · Einzellauf mit Profilauswahl

`POST /api/settings/auction/[platform]/[id]/reprocess`, Body `{ profileId }`.

- Profil per `getLlmProviderProfiles` auflösen → `resolveLlmConfig` → ein
  einzelner `LlmConfig`. Keine Kette, kein Fallback: gemessen werden soll genau
  dieses Modell.
- `reprocessAuction(...)` direkt aufrufen (bereits exportiert), Ergebnis mit
  `trial: true` und Provenienz schreiben.
- **Nicht** anfassen: `llm_failures`/`llm_last_attempted_at` — ein Experiment
  darf keine Auktion in den `MAX_LLM_FAILURES`-Lockout treiben — und
  `upsertCurrentAuctions`, damit die Suche unberührt bleibt.
- **Detached** (`{started:true}`) wie die anderen Long-Runner; eine
  Gutachten-Extraktion liegt über dem Reverse-Proxy-Timeout. Fortschritt braucht
  keine neue Statustabelle: die Seite pollt Versionsliste und
  `task_run_errors` dieser Auktion. Neue Trial-Version = fertig, neuer Fehler =
  gescheitert. Setzt WP-7 voraus.

## WP-5 · Vergleichen, freigeben, löschen

- **Diff:** zwei Versionen wählen, feldweiser Vergleich clientseitig über eine
  gemeinsame Feldliste (die Zeilen kommen vollständig aus WP-2). Nur
  Unterschiede hervorheben, Gleiches einklappbar.
- **Promote:** `POST …/versions/[version]/promote` — in einer Transaktion die
  alte `is_latest`-Zeile auf false, Zielzeile `is_latest = true, is_trial =
  false`; danach `invalidateAuctionDetailsCache()` und `upsertCurrentAuctions`,
  damit Suche und Detailseite die neue Version zeigen.
- **Löschen:** `DELETE …/versions/[version]` — verweigert wenn `is_latest`
  (erst promoten, dann löschen); damit bleibt die WP-0-Invariante „genau eine
  Live-Zeile pro Identität" erhalten. Cascades sind bereits korrekt:
  `auction_photos` über `auction_details_id`, `auction_translations` über die
  zusammengesetzte FK (`server/db/schema/translations.ts:65`). Mehrfachauswahl
  in der UI, Bestätigungsdialog.

**Verifizieren:** Test „Promote hebt genau eine Zeile, Partial-Unique bleibt
erfüllt" und „Delete einer Trial-Version entfernt zugehörige
Fotos/Übersetzungen, Live-Version unberührt".

## WP-6 · Public-Cleanup

Raus aus der Nutzeransicht:

- Analyse-Badge in `pages/objekt/[platform]/[id].vue:149` samt
  `analysisStatus`-Computed und den `objektDetail.analysisStatus.*`-Keys
- Extraktionshinweis „…automatisch extrahiert (hohe/niedrige Konfidenz)" in
  `components/Auction/DetailOverviewSections.vue:363`
- Roher `translationError`-Banner in `pages/objekt/[platform]/[id].vue:159-160`
  (`role="alert"`, Text kommt 1:1 aus `apiErrorMessage(err, ...)` in
  `useAuctionDetailTranslation.ts` — zeigt z.B. rohe Provider-Fehler wie
  `openrouter: [POST] "…/chat/completions": 404 Not Found` öffentlich an).
  Ersetzen durch stillen Fallback auf den unübersetzten Text; der Fehler
  selbst bleibt über `auction_translations.error_message` einsehbar (WP-2).

Bleiben: die `sourceChecked`-Attributionen bei Lage/Markt/Gefahren.

Die technischen Felder (`extraction.source`, `confidence`, `processing.*`)
bleiben in `AuctionDetail`, weil `hideRulesOnlyAuctions` und die
Übersetzungslogik sie serverseitig auswerten. Es geht ausschließlich um die
Darstellung. Sie auch aus der API-Antwort zu entfernen wäre ein separater,
größerer Eingriff — offen, falls gewünscht.

## WP-7 · Fehler pro Auktion sichtbar machen — ERLEDIGT

`runReprocess` schreibt im `catch`-Block (`server/tasks/reprocess.ts`) zusätzlich
`recordTaskRunError('reprocess', { platform, externalId, category, message })`,
`category` ist `'rate_limit' | 'llm_provider' | 'llm'` je nach
`isRateLimitError`/`isLlmProviderError`. `'reprocess'` war im `TrackedTask`-Typ
bereits enthalten (`server/utils/task-runs.ts:11`). Neuer Index
`idx_task_run_errors_platform_external_created` auf
`(platform, external_id, created_at desc)` für WP-2s Einzelauktions-Query
(Migration `0010_quiet_darwin.sql`).

**Übersetzungsfehler brauchten das nicht:** `failAuctionTranslation`
(`server/utils/content-translation.ts`) schreibt `status='failed'`,
`error_message`, `failed_config` bereits durable in `auction_translations` —
genau das, was WP-2 unter „Übersetzungen" liest. Der rohe Banner aus dem
Screenshot, der diese Untersuchung ausgelöst hat
(`pages/objekt/[platform]/[id].vue:159`, gespeist aus
`useAuctionDetailTranslation.ts`), zeigt exakt diesen `error_message`-Wert
1:1 auf der öffentlichen Seite an — das ist ein WP-6-Fall (Public-Cleanup),
nicht WP-7. Ursprünglich stand nur die Analyse-Badge und der
Extraktionshinweis unter WP-6; dieser Banner fehlte in der Aufzählung und
gehört ergänzt, bevor WP-6 umgesetzt wird.

## Reihenfolge

```text
WP-0 (Trial-Fundament)  ─┐  ✅ #368
WP-1 (Provenienz)       ─┤  ✅ #368  → WP-2 (API) → WP-3 (Seite) → WP-4 (Einzellauf) → WP-5 (Diff/Promote/Delete)
WP-7 (Fehler-Logging)   ─┘  ✅
WP-6 (Public-Cleanup)   ── unabhängig, jederzeit, offen
```

WP-0 und WP-1 sind zusammen in PR #368 gemergt — WP-1 ohne WP-0 hätte keine
sinnvolle Migration ergeben. WP-7 ist eigener PR. WP-2+3 gehören in einen PR
(API ohne UI bringt nichts), WP-4, WP-5 und WP-6 je einer.
