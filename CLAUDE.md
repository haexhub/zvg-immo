## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Settings-Seite (Admin-UI)

`pages/settings.vue` rendert die Cards aus `components/settings/*.vue` in drei Sektionen (Crawling & Anreicherung / KI-LLM / Verwaltung). "detached" = POST antwortet sofort mit `{started:true}`, der eigentliche Task läuft im Hintergrund weiter (Reverse-Proxy-Timeout umgehen); Fortschritt kommt über GET-Status bzw. `useSettingsTaskOverview`/`usePollWhileActive`.

| Card | Routen | Modus |
|---|---|---|
| SettingsCountrySourcesCard | GET/PUT `/api/settings/countries`, POST `/api/settings/countries/[code]/enrich` | Enrich detached |
| SettingsOsmImportCard | GET `/api/settings/osm-import`, POST `/api/settings/osm-import/[country]` | pro Land; der POST merkt die Anforderung nur vor, importiert wird vom täglichen Host-Job (nicht in dieser App) |
| SettingsGeoMetricsCard | GET/POST `/api/settings/geo-metrics` | detached, **nur ganz Europa** (kein Pro-Land-Scoping) |
| SettingsExternalDataCard | GET `/api/settings/external-data/sources`, PUT `.../sources/[id]`, POST `.../enrichment` | Enrichment detached; die drei Cache-Import-Buttons (`eu-flood-risk-cache`, `copernicus-effis-cache`, `fr-dvf-cache`) sind sync/awaited |
| SettingsReprocessCard | POST `/api/settings/reprocess` | detached |
| SettingsLlmKillSwitchCard | GET/PUT `/api/settings/llm-kill-switch` | sync, wirkt sofort ohne Redeploy; blockt extraction/translation/insights/admin-trial-run, indem die geteilten Config-Resolver (`readExtractionLlmConfigChain`, `resolveActiveLlmConfigChain`, `resolveLlmConfigForProfile`, Insight-Endpoint) auf "nicht konfiguriert" zurückfallen — bereits eingereichte Batch-Jobs werden weiter abgerufen |
| SettingsLlmConfigCard | GET/PUT `/api/settings/llm-config` | sync |
| SettingsLlmProfilesCard | GET/PUT `/api/settings/llm-profiles`, DELETE `.../llm-profiles/[id]`, POST `/api/settings/llm-provider/models` | sync |
| SettingsLlmAssignmentsCard | GET `/api/settings/llm-profiles`, PUT `/api/settings/llm-assignments` | sync |
| SettingsLlmBatchCard | GET `/api/settings/llm-batch-jobs` (geteiltes Status-Overview für Reprocess/Enrich/External-Enrichment/Offload) | sync |
| SettingsLawyersCard | GET/POST/PUT/DELETE `/api/settings/lawyers[/id]` | sync |
| SettingsDisplayCard | GET/PUT `/api/settings/display` | sync |
| ArchiveBrowser | GET `/api/settings/archive/{countries,regions,cases,documents}`, DELETE `.../archive/countries/[code]` | sync |
| SettingsClaudeFlow (in Reprocess/LlmProfiles/CountrySources/LlmBatch verschachtelt) | `/api/settings/claude/{status,login,code,reset,logout}` | sync, self-polling via `usePollWhileActive` solange ein Login-Flow aktiv ist |

Geteilte Composables: `useSettingsError` (401 → Session-Expiry), `useSettingsAction` (pending/error/run-Boilerplate), `useSettingsTaskOverview` (llm-batch-jobs, gebündeltes Polling), `usePollWhileActive` (generisches Intervall-Polling mit Abbruchbedingung), `useLlmProfileOptions` (geteilte Profil-Liste zwischen LlmProfiles/LlmAssignments).

## Search-Filter-Vertrag

`lib/auction-search-filter-contract.ts` besitzt die persistierten Such-URL-
und Saved-Search-Felder, Defaults, Parsing, Serialisierung und aktive
Filterzählung. UI-`region`-Keys (`de:sn`) bleiben dabei bewusst getrennt von
den für die SQL-Suche aufgelösten `regionNames`. Neue Filter zuerst dort
definieren und mit Round-trip-Tests absichern.

Alerts teilen die in-memory-Auswertung für alle verfügbaren Crawl-Felder;
`nearLat`/`nearLng`/`nearRadius` werden per Distanz geprüft. Umgebungskriterien
mit vorausberechneten Geo-/OSM-Metriken (`nearSea`, `nearLake`, `nearRiver`,
`nearMountain`, `nearAirport`, `nearSki`, `urbanRural`) sind für frische
Crawl-Batches nicht korrekt evaluierbar und werden beim Speichern bzw.
Aktivieren eines Alerts mit 400 abgelehnt. Alte betroffene Subscriptions werden
beim Matching übersprungen und protokolliert, nie stillschweigend gelockert.
