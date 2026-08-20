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
  Crawler darf ohne konfigurierte Zugangsdaten nicht crashen: sind
  `username` oder `password` nach `.trim()` leer, fällt er auf den
  bisherigen, rein öffentlichen Pfad zurück (Katalog-PDF weiterhin
  `excludeFromDocumentMining: true`).

Dieser Ansible-Teil (secrets.example + Templates) ist ein Änderung im
separaten `ansible`-Repo, nicht in diesem Workspace — eigener Worktree dort.

## Playwright-MCP: Status

`~/.claude.json`s `mcpServers.playwright` zeigte bisher auf den
`chrome`-Channel (`/opt/google/chrome/chrome`), der hier nicht installierbar
ist (braucht `sudo`, kein Terminal für das Passwort verfügbar). Fix bereits
angewendet: `npx playwright install chromium` (kein sudo nötig, lädt nur
Playwright-eigenes Chromium-Bundle nach `~/.cache/ms-playwright/`) plus
`~/.claude.json` `args` um `--executable-path <Pfad>` ergänzt. Der Pfad
enthält eine Versions-Revision (`chromium-XXXX/chrome-linux64/chrome`), die
sich mit jedem `playwright install` ändert — kein fest eingetragener Pfad,
sondern nach jeder Installation neu per `ls ~/.cache/ms-playwright/`
ermitteln. `--no-sandbox` bewusst weggelassen: nur ergänzen, falls der
Start ohne scheitert, und dann nur, solange der MCP-Prozess als
nicht-privilegierter Nutzer in einer isolierten Umgebung läuft.
**Erfordert einen Neustart/Reconnect der Claude-Code-Session**, um zu
greifen — der MCP-Serverprozess der laufenden Session hält noch die alte
Konfiguration.

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
   öffentlichen `.bs-overlay`-Ausschnitt. Zeigt die eingeloggte Seite einen
   PDF-Link, der sich vom öffentlichen Katalog-Link unterscheidet: erst
   verifizieren, dass dieses PDF tatsächlich nur das eine Objekt abdeckt
   (z.B. Seitenzahl, URL-/Dateinamensmuster, stichprobenartiger
   Inhaltsabgleich gegen ein zweites Objekt derselben Auktion), bevor
   `excludeFromDocumentMining` entfernt wird — sonst reproduziert sich der
   Bug aus PR #450 nur unter neuem Pfad. Bleibt die Zuordnung unklar oder
   ist das PDF weiterhin geteilt, `excludeFromDocumentMining: true`
   beibehalten und einen Test ergänzen, der diesen Ausschluss absichert.
   Erst bei eindeutigem Einzelobjektbezug greifen Foto- und LLM-Mining
   normal und liefern korrekte Zusatzfakten (Wohnfläche, Energieausweis,
   Baujahr, ...).
4. `nuxt.config.ts`: `runtimeConfig.dgaAg.{username,password}` ergänzen,
   `.env.example` dokumentieren (Platzhalter, kein echter Wert).
5. Fallback ohne Credentials: Crawler muss weiterhin funktionieren (aktueller
   öffentlicher Pfad + `excludeFromDocumentMining`), sobald `dgaAg.username`
   oder `dgaAg.password` (jeweils getrimmt) leer ist — kein
   Hard-Requirement einführen.
6. Ansible-Repo (separater Worktree): `secrets.example/haex.cloud.yml` um
   `dga_ag_username`/`dga_ag_password`-Platzhalter ergänzen, `.env.j2` +
   `quadlet/zvg-immo.container.j2` um die zwei `Environment=`-Zeilen.
7. Nach Deploy (einmalige Datenmigration, kein normaler Reprocess-Zyklus):
   bestehende dga-ag-Auktionen sind noch mit den kontaminierten
   Katalog-Fotos/(ggf.) LLM-Fakten aus der Zeit vor PR #450 markiert. Zwei
   getrennte, nacheinander abzuschließende Schritte:
   a. Erst einen auf `platform=dga-ag` begrenzten Enrich-/Archivierungslauf
      über den neuen authentifizierten Pfad anstoßen, der für JEDE
      bestehende dga-ag-Auktion Fotos/Dokumente neu holt — bis vollständig
      durchgelaufen abwarten, nicht nur angestoßen.
   b. Erst danach einen vollständigen LLM-Lauf für `platform=dga-ag`, der
      die zuvor gespeicherten (potenziell kontaminierten) LLM-Fakten
      EXPLIZIT invalidiert/zurücksetzt, bevor neu extrahiert wird.
   `photoPipelineVersion`-Bump allein reicht nicht (triggert nur die
   Foto-Seite, keine garantierte Neuextraktion bereits erfolgreicher
   LLM-Datensätze) und der bestehende `SettingsReprocessCard`/`force`-Knopf
   mit `maxLlmPerRun`-Deckel ist nicht dafür ausgelegt, garantiert ALLE
   betroffenen Objekte statt nur eines Batches abzudecken — für diese
   Migration braucht es einen expliziten, auf `dga-ag` gescopten
   Vollständigkeits-Check (alle vorgesehenen Objekte geprüft und
   verarbeitet, keins stillschweigend übersprungen).

## Nutzungsrichtlinien für authentifizierte Abfragen

Bis die tatsächlichen Account-Limits bekannt sind (siehe offene Frage
unten), gilt für den Crawl-Lauf ein konservativer Default:

- Max. Parallelität 1 (sequenziell, kein paralleler Objekt-Fetch), min. 1s
  Abstand zwischen authentifizierten Detail-Abfragen.
- Timeout pro Request analog zu den bestehenden dga-ag-Requests in
  `list.ts`/`detail.ts`.
- Der Login-`POST` wird bei Fehlschlag NICHT blind wiederholt: ein
  gescheiterter Login bricht den Lauf für diesen Crawl ab und fällt auf den
  öffentlichen Pfad zurück, statt in einer Retry-Schleife ggf. eine
  Account-Sperre auszulösen.
- Bei einer Rate-Limit-Antwort (HTTP 429 oder eine erkennbare Block-Seite):
  Lauf abbrechen, bereits gesammelte Objekte behalten, kein Retry
  innerhalb derselben Session — erst der nächste geplante Crawl-Lauf
  versucht es erneut.

Sobald der Nutzer die echten Limits kennt, diese Defaults entsprechend
verschärfen oder lockern.

## Offene Fragen für den Nutzer

- Deckt der Account-Zugang auch die Objektliste ab (mehr/aktuellere Objekte
  als der öffentliche Katalog), oder nur die Detailseite pro Objekt? Falls
  Ersteres, müsste auch `list.ts` auf den authentifizierten Pfad umgestellt
  werden, nicht nur `detail.ts`.
- Gibt es ein Rate-Limit/eine Nutzungsrichtlinie für den Account (z.B. max.
  Requests/Minute), die der Crawler einhalten muss?
