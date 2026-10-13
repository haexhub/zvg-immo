## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Settings-Seite (Admin-UI)

`pages/settings.vue` rendert nach dem Login (`/api/settings/{login,logout,session}`) zuerst `SettingsCountryStatusOverview` und danach die Cards aus `components/settings/*.vue` in vier Sektionen (Betrieb & Fehler / Crawling & Anreicherung / KI-LLM / Verwaltung). "detached" = POST antwortet sofort mit `{started:true}`, der eigentliche Task läuft im Hintergrund weiter (Reverse-Proxy-Timeout umgehen); Fortschritt kommt über GET-Status bzw. `useSettingsTaskOverview`/`usePollWhileActive`.
Manuelle Reprocess-/Enrich-/External-Enrichment-Trigger rufen `runReprocessTask`/`runEnrichTask`/`runExternalEnrichmentTask` direkt auf, nie Nitros `runTask` (das verwirft bei laufendem Task die Payload). Unter manuellen Reprocess-/External-Läufen gilt latest-run-wins; manuelle Enrich-Läufe reihen sich hinter den aktiven ein (ein Abbruch kostete Crawl und Finalize-Persistenz). Ein Cron-/Boot-Lauf überspringt, solange ein Lauf aktiv ist.

| Card | Routen | Modus |
|---|---|---|
| SettingsCountryStatusOverview | GET `/api/settings/{crawl-status,llm-status,translation-status-by-language,osm-import,status-snapshots}`, GET `/api/settings/{crawl,llm,translation,osm}-status/[country]`, POST `/api/settings/countries/[code]/{enrich,enrich-backlog,enrich-retry-failed,reprocess-backlog,reprocess-retry-failed,reprocess-force,translation-retry-open,translation-retry-failed}`, POST `/api/settings/auction/[platform]/[id]/{enrich,reprocess,translation}-retry`, POST `/api/settings/osm-enrichment/[country]`, POST `/api/settings/osm-import/[country]` | alle POSTs detached (Enrich verkettet Reprocess/External-Enrichment nach dem Crawl); `osm-import` merkt die Anforderung pro Land nur vor, importiert wird vom täglichen Host-Job (nicht in dieser App). Verschachtelt: SettingsAutomationControlsCard, SettingsCountrySourcesCard, SettingsTranslationLanguageStatusCard |
| SettingsAutomationControlsCard | GET/PUT `/api/settings/automation` | sync |
| SettingsCountrySourcesCard | GET/PUT `/api/settings/countries` | sync |
| SettingsOperationsCard | GET `/api/settings/operations` | sync |
| SettingsGeoMetricsCard | GET/POST `/api/settings/geo-metrics` | detached, **nur ganz Europa** (kein Pro-Land-Scoping) |
| SettingsExternalDataCard | GET `/api/settings/external-data/{sources,coverage}`, PUT `.../sources/[id]`, POST `.../enrichment`, POST `.../{eu-flood-risk,copernicus-effis,eurostat-tourism-nuts,fr-dvf}-cache` | Enrichment detached; die Cache-Importe `eu-flood-risk-cache`, `copernicus-effis-cache` und `eurostat-tourism-nuts-cache` laufen detached mit Status über `/api/settings/llm-batch-jobs`, nur `fr-dvf-cache` ist sync/awaited |
| SettingsReprocessCard | POST `/api/settings/reprocess` | detached, Ergebnis über `reprocessStatus` |
| SettingsLlmKillSwitchCard | GET/PUT `/api/settings/llm-kill-switch` | sync, wirkt sofort ohne Redeploy; blockt extraction/translation/admin-trial-run, indem die geteilten Config-Resolver (`readExtractionLlmConfigChain`, `resolveActiveLlmConfigChain`, `resolveLlmConfigForProfile`) auf "nicht konfiguriert" zurückfallen und `auction-admin-trial.ts` den Schalter direkt prüft — bereits eingereichte Batch-Jobs werden weiter abgerufen |
| SettingsLlmConfigCard | GET/PUT `/api/settings/llm-config` | sync |
| SettingsLlmProfilesCard | GET/PUT `/api/settings/llm-profiles`, DELETE `.../llm-profiles/[id]`, POST `/api/settings/llm-provider/models` | sync |
| SettingsLlmAssignmentsCard | GET `/api/settings/llm-profiles`, PUT `/api/settings/llm-assignments` | sync |
| SettingsLlmBatchCard | GET `/api/settings/llm-batch-jobs` (geteiltes Status-Overview für Reprocess/Enrich/External-Enrichment/Offload) | sync |
| SettingsLlmCostCard | GET `/api/settings/llm-costs` (aggregiert `llm_usage_events`) | sync |
| SettingsLawyersCard | GET/POST/PUT/DELETE `/api/settings/lawyers[/id]` | sync |
| SettingsOutboundDeliveriesCard | GET `/api/settings/outbound-deliveries` | sync |
| SettingsDisplayCard | GET/PUT `/api/settings/display` | sync |
| ArchiveBrowser | GET `/api/settings/archive/{countries,regions,cases,documents}`, GET `.../archive/download/[id]`, DELETE `.../archive/countries/[code]` | sync |
| SettingsClaudeFlow (nur in SettingsLlmProfilesCard, nur bei einem `claude-proxy`-Profil) | `/api/settings/claude/{status,login,code,reset,logout}` | sync, self-polling via `usePollWhileActive` solange ein Login-Flow aktiv ist |

Außerhalb der Settings-Seite nutzt `pages/admin/auktion/[platform]/[id].vue` die Routen unter `/api/settings/auction/[platform]/[id]/` (technical, versions, reprocess). Ohne UI-Aufrufer, nur per API: `/api/settings/llm-provider` GET/PUT/DELETE (Legacy-Provider-Override) und POST `/api/settings/countries/[code]/rebuild` (sync).

Geteilte Composables: `useSettingsError` (401 → Session-Expiry), `useSettingsAction` (pending/error/run-Boilerplate), `useSettingsTaskOverview` (llm-batch-jobs, gebündeltes Polling), `usePollWhileActive` (generisches Intervall-Polling mit Abbruchbedingung), `useLlmProfileOptions` (geteilte Profil-Liste zwischen LlmProfiles/LlmAssignments).

## Ausgehende Nachrichten

`outbound_deliveries` ist die langlebige, private Mail-Outbox. `outbound-delivery`
läuft alle fünf Minuten und beim Boot, claimed Zeilen mit `FOR UPDATE SKIP LOCKED`
und liefert mindestens einmal (kein Exactly-once-Versprechen). Erfolgreiche Alerts
werden erst danach in `notified_matches` bestätigt; fehlgeschlagene Zustellungen
werden exponentiell verzögert und nach sechs Versuchen terminal `failed`.
Fehlt `NUXT_SMTP_URL`, ist der Versand nur im Dev ein No-op; in Produktion
scheitert jede Zustellung mit `smtp_not_configured`.
`/api/settings/outbound-deliveries` zeigt nur sekretfreie Zähler/Fehlerklassen.

Anwaltsanfragen verlangen einen browsergenerierten `Idempotency-Key` (UUID),
werden zusammen mit genau einer Outbox-Zeile transaktional gespeichert und sind
auf 4.000 Zeichen sowie fünf Anfragen je Nutzer/Anwalt/Stunde begrenzt. Mail-Links
kommen ausschließlich von `NUXT_APP_ORIGIN` (`runtimeConfig.appOrigin`), nie vom
Request-Host.

## Search-Filter-Vertrag

`lib/auction-search-filter-contract.ts` besitzt die persistierten Such-URL-
und Saved-Search-Felder, Defaults, Parsing, Serialisierung und aktive
Filterzählung. UI-`region`-Keys (`de:sn`) bleiben dabei bewusst getrennt von
den für die SQL-Suche aufgelösten `regionNames`. Neue Filter zuerst dort
definieren und mit Round-trip-Tests absichern.

Alerts teilen die in-memory-Auswertung für alle verfügbaren Crawl-Felder;
`nearLat`/`nearLng`/`nearRadius` werden per Distanz gegen Quell- bzw. gecachte
Geocodes geprüft (cache-only, Treffer also ggf. erst nach dem Geocode-Task).
Umgebungskriterien
mit vorausberechneten Geo-/OSM-Metriken (`nearSea`, `nearLake`, `nearRiver`,
`nearMountain`, `nearAirport`, `nearSki`, `urbanRural`) sowie Kriterien aus
Extraktion/LLM-Analyse bzw. Detailseite (`landMin`/`landMax`, `livMin`/`livMax`,
`yearBuilt*`, `renovationYear*`, `condition`, `features`, `photos`,
`llmOnly=1`) sind für frische Crawl-Batches nicht korrekt evaluierbar und
werden beim Speichern bzw.
Aktivieren eines Alerts mit 400 abgelehnt. Alte betroffene Subscriptions werden
beim Matching übersprungen und protokolliert, nie stillschweigend gelockert.

## Modulgrößen

Produktionsdateien unter `server`, `components`, `composables`, `pages` und
`lib` bleiben bei höchstens 500 Zeilen. Der CI-Size-Gate in
`.github/workflows/ci.yml` prüft dies ohne Tests, Migrationen und Vendor-Code.
Bei Reprocess liegen Kandidaten/Input-Helper, Einzelauswertung und Orchestrierung
in getrennten Modulen unter `server/utils/tasks/`; Enrich trennt Auswahl, Worker
und Abschluss-Persistenz. Nitro registriert jede Datei in `server/tasks/` als
Task, dort liegen deshalb nur `defineTask`-Fassaden. Die öffentlichen Task- und
Utility-Importpfade bleiben Fassaden.

## Öffentliche Daten-Lesepfade

`/api/data/v1/auctions` liest über `server/utils/data-api-auction.ts` eine
schmale `PublicAuction`-Projektion mit parameterisierten Filtern, stabilem
`platform/external_id`-Sort, `COUNT(*)`, `LIMIT` und `OFFSET`. Die Collection
zeigt ausschließlich aktuelle (nicht abgelaufene) Auktionen; der einzelne
Detail-Endpunkt bleibt ein historischer Permalink. `auction-record.ts` bleibt
der separate, breite interne Detail-Leser.

`/api/auctions-geo` ist auch bei dem Legacy-Parameter `fetch=1` cache-only;
fehlende Geocodes erzeugt ausschließlich der exklusive geplante/Admin-Task.
`pages/search.vue` pollt nur den Cache-Fortschritt und bricht einen laufenden
Poll beim Stoppen ab. Detail-Reads für `location_enrichment` sind per
`platform` und `external_id` abgefragt und haben einen eigenen invalidierbaren
Key-Cache; die Volltabellen-Cache-Funktion bleibt allein für Batch-Enrichment.
