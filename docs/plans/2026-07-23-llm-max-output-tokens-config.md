# LLM Max-Output-Tokens: admin-konfigurierbar, von allen Providern beachtet

**Datum:** 2026-07-23
**Anlass:** Code-Review von PR #145 (`fix: summary/translation endpoints send the
wrong LLM wire format`). Dabei aufgefallen: `GeminiNativeProvider.extract()`
setzt nie ein `maxOutputTokens`-Limit — das `LlmConfig.maxTokens`, das
`resolveLlmConfig()` für summary/translation setzt (1024 bzw. 8192), wirkt für
den in Prod tatsächlich konfigurierten Provider (`gemini-native`) also nicht.
Nutzerwunsch daraufhin: (1) diese Grenze im Dashboard änderbar machen, ohne
Redeploy, (2) sicherstellen, dass **alle** genutzten Provider sie wirklich
anwenden.

**Ziel:** Ein Dashboard-Abschnitt unter `/settings`, in dem sich die
Max-Output-Tokens-Grenze pro Anwendungsfall (Extraction / Summary /
Translation) ändern lässt, persistiert in Postgres, sofort wirksam für den
nächsten LLM-Call — und alle drei Provider (`ClaudeProxyProvider`,
`OpenAiCompatibleProvider`, `GeminiNativeProvider`) respektieren den
konfigurierten Wert tatsächlich.

**Entscheidungen (mit Nutzer abgestimmt):**
- **Getrennte Werte pro Anwendungsfall**, kein einzelner globaler Dial.
  Begründung: Extraction (Gutachten-JSON mit `insights`, Foto-Kuratierung,
  ...) braucht strukturell mehr Budget als Summary; ein einzelner Wert würde
  entweder Extraction zu knapp abschneiden oder Summary unnötig teuer machen.
- **Neue generische `app_settings`-Tabelle** (key/value, jsonb) statt einer
  dedizierten `llm_settings`-Tabelle — wiederverwendbar für künftige
  Dashboard-Settings (Kandidat: `maxLlmPerRun`, aktuell nur per ENV
  änderbar, siehe `server/tasks/enrich.ts:109-112` /
  `server/tasks/reprocess.ts:73-75` — nicht Teil dieses Plans, nur als
  Beleg, dass die Tabelle wiederverwendet werden dürfte).

---

## Ausgangslage (verifiziert am 2026-07-23)

- `LlmConfig.maxTokens` (`server/utils/extract/llm.ts:52`) ist optional und
  wird nur von zwei der drei Provider gelesen:
  - `ClaudeProxyProvider.extract()` (`server/utils/extract/providers/claude-proxy.ts:38`):
    `max_tokens: this.config.maxTokens ?? 4096`
  - `OpenAiCompatibleProvider.extract()` (`server/utils/extract/providers/openai-compatible.ts:...`):
    `max_tokens: this.config.maxTokens ?? 4096`
  - `GeminiNativeProvider.extract()` (`server/utils/extract/providers/gemini-native.ts`):
    `generationConfig` enthält kein `maxOutputTokens` — der Wert wird
    komplett ignoriert, unabhängig davon, was `config.maxTokens` sagt.
- Vier Aufrufer bauen ihre `LlmConfig` heute **auf drei verschiedene Arten**:
  - `server/utils/extract/llm.ts` → `resolveLlmConfig()` (aus PR #145),
    genutzt von `summary.post.ts` (`{ maxTokens: 1024 }` hart codiert) und
    `translation.post.ts` (`{ maxTokens: 8192 }` hart codiert).
  - `server/tasks/enrich.ts:95-107` → eigene private `readLlmConfig()`,
    **ohne** `maxTokens`-Feld überhaupt zu setzen (Extraction läuft also
    immer auf den Provider-internen `?? 4096`-Fallback).
  - `server/tasks/reprocess.ts:58-71` → nahezu identische Kopie derselben
    `readLlmConfig()`.
- Alle drei Config-Quellen lesen ausschließlich aus
  `useRuntimeConfig().extractLlm` (ENV-gespeist, `nuxt.config.ts:69-73`) —
  eine Änderung braucht heute einen Redeploy. Es gibt aktuell **keinen**
  DB-gestützten Runtime-Settings-Mechanismus; `/settings` (`pages/settings.vue`)
  kennt nur Claude-OAuth-Verbindung und die Anwälte-CRUD
  (`server/api/settings/lawyers/*`, Postgres-Tabelle `lawyers`).
- `server/api/settings/*` erbt automatisch den Auth-Guard aus
  `server/middleware/settings-auth.ts` — neue Routen unter diesem Pfad
  brauchen keine eigene Auth-Prüfung.

---

## Umsetzung (Work Packages)

### WP-A — `app_settings`-Tabelle + Utility

- `server/db/schema.sql`: neue Tabelle, analog zu `lawyers`
  (RLS aktiviert, keine Policies — Server verbindet als Tabellenbesitzer,
  gleiche Begründung wie beim `lawyers`-Kommentar):
  ```sql
  CREATE TABLE IF NOT EXISTS app_settings (
    key         text PRIMARY KEY,
    value       jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
  ```
- Neue Datei `server/utils/app-settings.ts`:
  - `type LlmMaxTokensKind = 'extraction' | 'summary' | 'translation'`
  - `DEFAULT_LLM_MAX_TOKENS: Record<LlmMaxTokensKind, number>` — exakt die
    heutigen hart codierten Werte (`extraction: 4096, summary: 1024,
    translation: 8192`), damit der erste Rollout ohne gesetzten DB-Wert
    keine Verhaltensänderung ist.
  - `getLlmMaxTokens(db: Pool, kind: LlmMaxTokensKind): Promise<number>` —
    liest eine Zeile (`key = 'llm_max_tokens_' + kind`), fällt bei
    fehlender Zeile / kaputtem Wert auf `DEFAULT_LLM_MAX_TOKENS[kind]`
    zurück. **Kein Werfen bei fehlender DB** — Aufrufer entscheiden selbst,
    ob sie ganz ohne Postgres degradieren (siehe WP-C).
  - `getAllLlmMaxTokens(db: Pool): Promise<Record<LlmMaxTokensKind, number>>`
    — eine Query für alle drei Keys, für den Admin-GET-Endpoint.
  - `setLlmMaxTokens(db, kind, value)` — Upsert; Wert vor dem Schreiben auf
    einen sinnvollen Bereich klemmen (Vorschlag: `256`–`32768`, integer),
    damit eine Fehleingabe im Dashboard nicht jeden LLM-Call lahmlegt oder
    Kosten explodieren lässt.
  - Unit-Tests (gemocktes `Pool`), Stil wie `llm.test.ts`.

### WP-B — Gemini-Provider wendet `maxTokens` tatsächlich an

- `server/utils/extract/providers/gemini-native.ts`: `generationConfig` um
  `maxOutputTokens: this.config.maxTokens ?? 4096` ergänzen (gleicher
  Fallback-Wert wie die anderen beiden Provider, für Konsistenz).
- Bestehende/neue Provider-Tests um eine Assertion ergänzen, dass
  `maxOutputTokens` im Request-Body ankommt.
- Kein Änderungsbedarf an `ClaudeProxyProvider`/`OpenAiCompatibleProvider`
  — die wenden `config.maxTokens` schon an.

### WP-C — Aufrufer lesen den DB-Wert statt hart codierter Zahlen

- `summary.post.ts`: Postgres ist hier heute **keine** Voraussetzung (nur
  Disk-Cache, `summary-cache.ts`). `getPool()` zusätzlich holen; ist ein
  Pool da, `await getLlmMaxTokens(db, 'summary')`, sonst
  `DEFAULT_LLM_MAX_TOKENS.summary` — **weich degradieren**, nicht 503,
  damit Summary-Generierung nicht plötzlich von Postgres abhängt.
- `translation.post.ts`: hat bereits einen harten `getPool()`-Require
  (503 `'translation cache not configured'`) — dort einfach denselben
  `db`-Handle für `getLlmMaxTokens(db, 'translation')` mitbenutzen, kein
  neuer Fallback-Pfad nötig.
- `server/tasks/enrich.ts` / `server/tasks/reprocess.ts`: die private
  `readLlmConfig()` in beiden Dateien entfernen, stattdessen das schon
  vorhandene `resolveLlmConfig()` aus `llm.ts` importieren (spart die
  doppelte Provider-Shape-Parsing-Logik) und mit
  `{ maxTokens: await getLlmMaxTokens(db, 'extraction') }` aufrufen —
  `db = getPool()`, bei `null` auf `DEFAULT_LLM_MAX_TOKENS.extraction`
  zurückfallen (gleiches Degradier-Muster wie bei fehlendem
  `extractLlm.baseUrl`). `readLlmConfig()` wird dadurch `async`; beide
  Aufrufstellen liegen außerhalb enger Schleifen (einmal pro Task-Lauf,
  nicht pro Auktion), also unkritisch.

### WP-D — Dashboard-UI

- Neue Routen `server/api/settings/llm-config.get.ts` +
  `llm-config.put.ts` (erben automatisch den `settings-auth`-Guard, gleiches
  Muster wie `server/api/settings/lawyers/*`): GET liefert
  `{ extraction, summary, translation }`, PUT nimmt dieselbe Form
  entgegen und validiert/klemmt serverseitig (siehe `setLlmMaxTokens`).
- `pages/settings.vue`: neue `Card` "LLM-Konfiguration" nach dem
  Anwälte-Abschnitt, drei Zahlenfelder (Extraction/Summary/Translation),
  Laden beim Mount (neben `refreshStatus`/`loadLawyers`), Speichern über
  PUT, gleiches Pending/Error-Muster wie das Anwälte-Formular.
- i18n: neue Keys unter `settings.llm.*` in **beiden** Locale-Dateien
  (`i18n/locales/de.json`, `i18n/locales/en.json` — nur diese zwei
  existieren für UI-Strings).

### WP-E — Verifikation

- `pnpm exec nuxt prepare` (Pflicht vor Tests in diesem Projekt) →
  `pnpm exec vitest run` (neue + betroffene Tests) →
  `pnpm exec tsc -p .nuxt/tsconfig.server.json --noEmit`.
- Manuell: Wert im Dashboard ändern, prüfen dass ein danach ausgelöster
  Summary-/Translation-Call bzw. ein `enrich`-Lauf den neuen Wert ohne
  Redeploy zieht (z. B. Log-Zeile in `enrich.ts:206` um `maxTokens`
  ergänzen, für Sichtbarkeit im Prod-Log).

---

## Offene Punkte / bewusst nicht im Scope

- Kein Caching-Layer für den DB-Read — jeder Call-Site macht ein frisches
  `SELECT`. Frequenz ist niedrig genug (einmal pro HTTP-Request bzw. einmal
  pro Hintergrund-Task-Lauf, nicht pro Auktion), zusätzliche Cache-Invalidierung
  wäre unnötige Komplexität.
- Keine Änderung der **Default**-Werte selbst (4096/1024/8192) — nur, dass
  sie jetzt überschreibbar sind.
- `maxLlmPerRun` (ENV-only) bewusst nicht mitmigriert — die neue Tabelle ist
  nur so gebaut, dass sie das später leicht könnte, ist aber kein Teil
  dieses PRs.
