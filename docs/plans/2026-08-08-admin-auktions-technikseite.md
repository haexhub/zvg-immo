# Admin-Technikseite pro Auktion + LLM-Modellvergleich

Stand: 2026-08-08 · Status: WP-0 bis WP-5 umgesetzt (WP-6+WP-7 parallel, s. Reihenfolge)

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

## WP-2 · Technik-API — ERLEDIGT

`GET /api/settings/auction/[platform]/[id]/technical`
(`server/api/settings/auction/[platform]/[id]/technical.get.ts`), ein Endpoint,
ein Aggregat (`server/utils/auction-technical.ts`), alles aus vorhandenen
Tabellen:

- **Identität & Geocoding** — `auctions` inkl. `geocode_attempted_at/result/provider`, `first_seen_at`, `updated_at`
- **Crawl/Fetch-Zustand** — `readAuctionFetchState()` (bereits vorhanden) wiederverwendet statt dupliziert
- **Dokumentarchiv** — Query aus `server/api/settings/archive/documents.get.ts` nach `server/utils/archive-documents.ts` gezogen, von beiden Endpoints genutzt
- **Extraktionshistorie** — alle `auction_details`-Zeilen mit Version, Zeitstempeln, `is_latest`/`is_trial`, Provenienz aus WP-1
- **LLM-Batch** — `listRecentLlmBatchJobs()` (letzte 50) client-seitig nach `custom_id_map`-Werten `"platform:externalId"` gefiltert, keine neue Query
- **Fehler** — neue `listTaskRunErrorsForIdentity()` in `task-run-errors.ts`, task-übergreifend (enrich + reprocess) über den neuen Index `idx_task_run_errors_platform_external_created` aus WP-7
- **Externe Daten** — `server/utils/external-data/auction-coverage.ts` (Einzelauktions-Variante von `coverage.ts`s Prädikaten) plus `auction_geo_metrics` + verknüpfte `climate_cells`-Zeile
- **Übersetzungen** — `auction_translations`-Status je Sprache/Version inkl. `failed_config`

**Verifiziert:** `pnpm test` mit gemocktem Pool (`auction-technical.test.ts`,
erweiterte `task-run-errors.test.ts`) — kein Testcontainer-Integrationstest
gegen echtes Postgres, das bleibt offen, falls gewünscht.

## WP-3 · Admin-Seite — ERLEDIGT

`pages/admin/auktion/[platform]/[id].vue`.

Auth-Muster wie `pages/settings.vue`: `onMounted` → `/api/settings/session`
proben, sonst Login-Formular (teilt `settings.login.*`-i18n-Keys). Sektionen als
`Card`s, `useSettingsError` wiederverwendet. Neue i18n-Keys unter
`settings.auctionTechnical.*` in `de.json` und `en.json`.

Auf der öffentlichen Objektseite (`pages/objekt/[platform]/[id].vue`) ein
dezenter „Technik"-Link neben dem Aktenzeichen, der nur clientseitig nach
erfolgreicher Session-Probe gerendert wird (kein SSR-Leak) — neuer i18n-Key
`objektDetail.technicalLink`.

Neue i18n-Keys unter `settings.auctionTechnical.*` in `de.json` **und** `en.json`.

## WP-4 · Einzellauf mit Profilauswahl — ERLEDIGT

`POST /api/settings/auction/[platform]/[id]/reprocess`, Body `{ profileId }`
(`server/api/settings/auction/[platform]/[id]/reprocess.post.ts`).

- Neues `resolveLlmConfigForProfile(db, profileId)` in `llm-task-config.ts`:
  Profil per `getLlmProviderProfiles` auflösen → `resolveLlmConfig` → ein
  einzelner `LlmConfig`. Keine Kette, kein Fallback.
- `server/utils/auction-admin-trial.ts` ruft `reprocessAuction(...)` direkt auf
  (bereits exportiert) und schreibt das Ergebnis mit `trial: true` und
  Provenienz (`runTrigger: 'manual'`).
- **Nicht** angefasst: `llm_failures`/`llm_last_attempted_at` (kein
  `writeAuctionLlmPipelineState`-Aufruf) und `upsertCurrentAuctions` — beide
  Utils werden im Trial-Pfad schlicht nicht importiert.
- **Detached** (`{started:true}`), Validierung (unbekanntes Profil/Auktion)
  läuft synchron vorher. Fehler im Hintergrundlauf landen über
  `recordTaskRunError('reprocess', { category: 'admin_trial', ... })` in
  `task_run_errors` (WP-7).
- Admin-Seite: Profil-Dropdown (`useLlmProfileOptions`, wie
  `SettingsLlmProfilesCard`) + „Testlauf starten" in der
  Extraktionshistorie-Card. Poll-Mechanik via `usePollWhileActive`: vor dem
  Trigger ein Snapshot aus Versionen/Fehler-IDs, danach pollt die Seite
  `loadOverview()` bis eine neue `isTrial`-Version (Erfolg) oder ein neuer
  Fehler-Eintrag (Fehlschlag) auftaucht.

**Verifiziert:** `pnpm test` (`auction-admin-trial.test.ts`,
`llm-task-config.test.ts`, `reprocess.post.test.ts`) mit gemockten
Abhängigkeiten — kein Lauf gegen eine echte Auktion.

## WP-5 · Vergleichen, freigeben, löschen — ERLEDIGT

- **Diff:** `GET …/versions/[version]` (neu, getrennt von der Technik-Übersicht
  — auf Abruf nur für die zwei gewählten Versionen, nicht für jede Version bei
  jedem Seitenaufruf) liefert die vollen Feldwerte. Checkbox-Mehrfachauswahl in
  der Extraktionshistorie-Tabelle: genau 2 ausgewählt aktiviert „Vergleichen",
  clientseitiger feldweiser Vergleich über eine feste Feldliste
  (`DIFF_FIELDS` in der Seite). Per Default nur Unterschiede sichtbar, „Auch
  gleiche Felder anzeigen"-Checkbox klappt den Rest auf.
- **Promote:** `POST …/versions/[version]/promote` →
  `promoteAuctionDetailsVersion()` in `auction-details.ts` — in einer
  Transaktion unter demselben Advisory-Lock wie `writeAuctionDetails` die alte
  `is_latest`-Zeile auf false, Zielzeile `is_latest = true, is_trial = false`;
  danach `invalidateAuctionDetailsCache()` und `upsertCurrentAuctions`. Pro
  Zeile ein „Live schalten"-Button (nicht Teil der Mehrfachauswahl — Promote
  hat immer genau ein Ziel).
- **Löschen:** `DELETE …/versions/[version]` → `deleteAuctionDetailsVersion()`
  — atomarer `DELETE … WHERE is_latest = false RETURNING version`, verweigert
  also die Live-Version race-frei statt über ein separates Check-then-Delete.
  Cascades bereits korrekt: `auction_photos` über `auction_details_id`,
  `auction_translations` über die zusammengesetzte FK. Mehrfachauswahl bedient
  Diff (genau 2) und Löschen (1+) über dieselben Checkboxen;
  `window.confirm()` vor dem Löschen (gleiches Muster wie `ArchiveBrowser.vue`s
  Länder-Löschen).

**Verifiziert:** `describeDb`-Tests in `auction-details.test.ts` gegen einen
frischen `supabase/postgres`-Container mit `pnpm db:migrate` (Promote
demoted/befördert korrekt, ist idempotent auf der bereits-live Version;
Delete verweigert die Live-Version, kaskadiert Fotos für eine Trial-Version).
Endpoints per Unit-Test mit gemockten Utils.

**Verifizieren:** Test „Promote hebt genau eine Zeile, Partial-Unique bleibt
erfüllt" und „Delete einer Trial-Version entfernt zugehörige
Fotos/Übersetzungen, Live-Version unberührt".

## WP-6 · Public-Cleanup

Raus aus der Nutzeransicht:

- Analyse-Badge in `pages/objekt/[platform]/[id].vue:149` samt
  `analysisStatus`-Computed und den `objektDetail.analysisStatus.*`-Keys
- Extraktionshinweis „…automatisch extrahiert (hohe/niedrige Konfidenz)" in
  `components/Auction/DetailOverviewSections.vue:363`

Bleiben: die `sourceChecked`-Attributionen bei Lage/Markt/Gefahren.

Die technischen Felder (`extraction.source`, `confidence`, `processing.*`)
bleiben in `AuctionDetail`, weil `hideRulesOnlyAuctions` und die
Übersetzungslogik sie serverseitig auswerten. Es geht ausschließlich um die
Darstellung. Sie auch aus der API-Antwort zu entfernen wäre ein separater,
größerer Eingriff — offen, falls gewünscht.

## WP-7 · Fehler pro Auktion sichtbar machen

`runReprocess` schreibt im `catch`-Block (`server/tasks/reprocess.ts:923`)
zusätzlich `recordTaskRunError('reprocess', { platform, externalId, category,
message })`. `'reprocess'` ist im `TrackedTask`-Typ bereits enthalten
(`server/utils/task-runs.ts:11`). Ohne das bleibt „wo gab es Fehler" für den
LLM-Zweig unbeantwortbar und WP-4 hat keine Fehlerrückmeldung.

## Reihenfolge

```
WP-0 (Trial-Fundament)  ─┐  ✅ #368
WP-1 (Provenienz)       ─┤  ✅ #368  → WP-2 (API) ✅ → WP-3 (Seite) ✅ → WP-4 (Einzellauf) ✅ → WP-5 (Diff/Promote/Delete) ✅
WP-7 (Fehler-Logging)   ─┘  ✅ (paralleler PR, s. Kopf dieses Dokuments)
WP-6 (Public-Cleanup)   ── unabhängig, jederzeit ✅ (paralleler PR)
```

WP-0 und WP-1 sind zusammen in PR #368 gemergt — WP-1 ohne WP-0 hätte keine
sinnvolle Migration ergeben. WP-2+3, WP-4 und WP-5 sind je ein gestapelter PR
(jeder baut auf dem vorigen Branch auf); WP-6 und WP-7 liefen parallel dazu
von main ab. Alle fünf noch offenen PRs (#370–#374) ändern denselben
Reihenfolge-/Statusabschnitt dieses Dokuments — beim Mergen sind dort kleine,
triviale Konflikte zu erwarten, kein Blocker.
