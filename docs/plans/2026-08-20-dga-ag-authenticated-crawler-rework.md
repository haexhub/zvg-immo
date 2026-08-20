# dga-ag: Umbau auf authentifizierte Einzelabfragen

Status: TODO (Recherche abgeschlossen, Implementierung offen)
Vorarbeit: PR #450 (gemerged/offen) — schließt den geteilten Katalog aus Foto-
und LLM-Dokumentmining aus (`excludeFromDocumentMining`), als Übergangs-
Absicherung bis dieser Umbau steht.

## Ausgangslage

`server/crawlers/dga-ag/*` liest bisher ausschließlich den öffentlichen
Bereich von dga-ag.de:

- `list.ts`: eine serverseitig gerenderte Katalogseite mit ~250 Objekten
  (kein Pagination, jplist filtert nur clientseitig).
- `detail.ts`: die öffentliche Objektseite liefert Titel (`og:title`),
  Beschreibung (Label "Lage und Umfeld dieser Immobilie"), eine kleine
  Fotostrecke (`.bs-overlay .zoom-handle img`) und einen Link auf das
  gemeinsame Katalog-PDF (`Katalog_S26-0X.pdf#page=N`) — ein einziges PDF für
  ~90 Auktionslose eines Termins.

Das Katalog-PDF wurde bisher trotzdem als Attachment (`kind: 'brochure'`)
für Foto- und LLM-Dokumentmining herangezogen, obwohl `pdftotext`/`pdfimages`
keine Vorstellung von "die Seiten dieses einen Loses" haben — das bündelte
Fotos und (bei LLM-Reprocessing) Fakten fremder Lose in die falsche Auktion
(siehe PR #450 für die Live-Verifikation an S26-03-011: 49 von 52
Galeriebildern zeigten fremde Objekte).

Der Nutzer hat jetzt einen Login-Account für dga-ag.de. Eingeloggt sollen
pro Auktion **einzelne** Abfragen möglich sein, die nur dieses eine Objekt
betreffen (eigene Fotos, eigene Dokumente) — der gemeinsame Katalog entfällt
dann als Datenquelle.

## Login-Mechanismus (bereits reverse-engineered, ohne echten Login getestet)

dga-ag.de läuft auf TYPO3 mit der `felogin`-Extension:

- Login-Link: `/login.html`.
- Formular (aus `GET /login.html` extrahiert):
  `POST /login.html?tx_felogin_login[action]=login&tx_felogin_login[controller]=Login&cHash=<aus GET>`
  Felder: `user` (E-Mail), `pass`, `logintype=login`, `pid=721`.
- TYPO3 schützt das Formular mit **pro Seitenaufruf frischen** Hidden-Feldern:
  `__referrer[@extension|@controller|@action|arguments|@request]`,
  `__RequestToken` (JWT, an eine Nonce-Cookie gebunden), `__trustedProperties`.
  → Der Crawler muss erst `GET /login.html` machen, diese Werte + die
  `Set-Cookie`-Session (`__Secure-typo3nonce_...`) einsammeln, und beides
  zusammen mit den Zugangsdaten zurück-posten. Danach trägt die Session-Cookie
  den authentifizierten Zustand für Folge-Requests.
- Strukturell identisch zum bereits vorhandenen Session-Etablierungs-Muster in
  `server/crawlers/cz/list.ts` (`establishSession()`: GET → CSRF-Token aus
  `<meta>` + `PHPSESSID` aus `Set-Cookie` → nachfolgende Requests mit beiden
  Headern) und `server/crawlers/lv/list.ts` (`establishFilterSession()`).
  Kein gemeinsames Cookie-Jar-Utility existiert projektweit — jeder Crawler
  baut das lokal in seiner `list.ts`/`fetch.ts`.

**Offen, weil noch nicht mit echtem Login getestet:** wie genau sich eine
eingeloggte Objektseite vom öffentlichen HTML unterscheidet — eigener
PDF-Link pro Objekt? Eigene, größere Fotostrecke? Zusätzliche Felder
(Energieausweis, Flurstücke, Exposé-Download)? Das muss der nächste Schritt
per Playwright-Login klären (siehe unten).

## Zugangsdaten: Ablage in Ansible

Der Nutzer legt die dga-ag.de-Zugangsdaten in `~/Projekte/ansible` (separates
Repo, siehe `ansible-zvg-immo-role.md`-Memory) ab, nach demselben Muster wie
bereits vorhandene zvg-immo-Secrets:

- Vorlage: `secrets.example/haex.cloud.yml` — Namespace `zvg_immo:` (z.B.
  `gemini_api_key`, `maptiler_api_key` als bestehende Beispiele). Neue Keys
  vorschlagen: `dga_ag_username`, `dga_ag_password`.
- Reale (gitignorete) Werte: `secrets/haex.cloud.yml`, gleicher Pfad.
- Templating in die App: `roles/zvg-immo/templates/.env.j2` UND
  `roles/zvg-immo/templates/quadlet/zvg-immo.container.j2` bekommen je eine
  neue `Environment=NUXT_DGA_AG_USERNAME=...` / `NUXT_DGA_AG_PASSWORD=...`
  Zeile, exakt nach dem Muster von `NUXT_EXTRACT_LLM_API_KEY` (Zeile 23/29
  in den beiden Dateien).
- Auf der zvg-immo-Seite: `nuxt.config.ts`s `runtimeConfig` bekommt einen
  neuen Block, z.B.
  ```ts
  dgaAg: {
    username: '',
    password: '',
  },
  ```
  gelesen über `useRuntimeConfig().dgaAg` — analog zu `extractLlm`. Der
  Crawler darf ohne konfigurierte Zugangsdaten nicht crashen: fehlt
  `username`/`password`, fällt er auf den bisherigen, rein öffentlichen Pfad
  zurück (Katalog-PDF weiterhin `excludeFromDocumentMining: true`).

Dieser Ansible-Teil (secrets.example + Templates) ist ein Änderung im
separaten `ansible`-Repo, nicht in diesem Workspace — eigener Worktree dort.

## Playwright-MCP: Status

`~/.claude.json`s `mcpServers.playwright` zeigte bisher auf den
`chrome`-Channel (`/opt/google/chrome/chrome`), der hier nicht installierbar
ist (braucht `sudo`, kein Terminal für das Passwort verfügbar). Fix bereits
angewendet: `npx playwright install chromium` (kein sudo nötig, lädt nur
Playwright-eigenes Chromium-Bundle in `~/.cache/ms-playwright/chromium-1234`)
plus `~/.claude.json` `args` um `--executable-path
/home/haex/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome
--headless --no-sandbox` ergänzt. **Erfordert einen Neustart/Reconnect der
Claude-Code-Session**, um zu greifen — der MCP-Serverprozess der laufenden
Session hält noch die alte Konfiguration.

## Nächste Schritte (nächste Session)

1. Nach Session-Neustart: `mcp__playwright__browser_navigate` zur Login-Seite
   testen, dann mit den echten Zugangsdaten einloggen und eine Objektseite
   (z.B. `.../objekt/S26-03-011.html`) im eingeloggten Zustand ansehen —
   HTML-Struktur/Snapshot festhalten (eigenes PDF? eigene Fotos? welche
   zusätzlichen Felder?).
2. Login-Flow in `server/crawlers/dga-ag/fetch.ts` (neu) oder direkt in
   `list.ts`/`detail.ts` nach dem cz/lv-Muster implementieren: GET
   `/login.html` → Tokens/Cookie extrahieren → POST mit Credentials →
   Session-Cookie für alle Folge-Requests dieses Crawl-Laufs merken.
3. `detail.ts` erweitern: mit Session die authentifizierte Objektseite lesen,
   objektEIGENE Fotos/Dokumente extrahieren statt (oder zusätzlich zu) dem
   öffentlichen `.bs-overlay`-Ausschnitt. Falls die eingeloggte Seite ein
   objektspezifisches PDF verlinkt (statt des Katalogs), dieses als
   Attachment OHNE `excludeFromDocumentMining` führen — dann greifen Foto-
   und LLM-Mining wieder normal und liefern erstmals korrekte Zusatzfakten
   (Wohnfläche, Energieausweis, Baujahr, ...).
4. `nuxt.config.ts`: `runtimeConfig.dgaAg.{username,password}` ergänzen,
   `.env.example` dokumentieren (Platzhalter, kein echter Wert).
5. Fallback ohne Credentials: Crawler muss weiterhin funktionieren (aktueller
   öffentlicher Pfad + `excludeFromDocumentMining`), falls `dgaAg.username`
   leer ist — kein Hard-Requirement einführen.
6. Ansible-Repo (separater Worktree): `secrets.example/haex.cloud.yml` um
   `dga_ag_username`/`dga_ag_password`-Platzhalter ergänzen, `.env.j2` +
   `quadlet/zvg-immo.container.j2` um die zwei `Environment=`-Zeilen.
7. Nach Deploy: bestehende dga-ag-Auktionen sind noch mit den kontaminierten
   Katalog-Fotos/(ggf.) LLM-Fakten aus der Zeit vor PR #450 markiert. Sobald
   der authentifizierte Pfad live ist, `photoPipelineVersion` für `dga-ag` in
   `server/tasks/enrich-work-selection.ts` nochmal erhöhen (aktuell 6) und
   einen `force`-Reprocess mit `platform=dga-ag` über die bestehende
   `/settings`-Aktion (SettingsReprocessCard) anstoßen, damit alle Objekte
   mit den jetzt korrekten, objekteigenen Daten neu aufgebaut werden.

## Offene Fragen für den Nutzer

- Deckt der Account-Zugang auch die Objektliste ab (mehr/aktuellere Objekte
  als der öffentliche Katalog), oder nur die Detailseite pro Objekt? Falls
  Ersteres, müsste auch `list.ts` auf den authentifizierten Pfad umgestellt
  werden, nicht nur `detail.ts`.
- Gibt es ein Rate-Limit/eine Nutzungsrichtlinie für den Account (z.B. max.
  Requests/Minute), die der Crawler einhalten muss?
