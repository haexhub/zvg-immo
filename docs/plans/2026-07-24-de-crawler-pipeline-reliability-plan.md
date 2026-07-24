# DE-Crawler-Pipeline: Foto-Zuverlässigkeit, Rotation, Verkehrswert, Extraktionsqualität

Date: 2026-07-24
Status: Draft — Review ausstehend
Auslöser: Nutzer-Report zu `zvg-portal/14409` (Amtsgericht Köpenick, GZ 70 K 7/25,
unbebautes Grundstück Paradiesstraße 214-218, Berlin-Köpenick).

## Ausgangslage

Vier voneinander unabhängige Probleme wurden gemeldet. Alle vier wurden am
konkreten Fall verifiziert (u.a. durch Live-Abruf des echten Gutachten-PDFs von
zvg-portal.de und Analyse mit `pdfimages`/`pdfinfo`), nicht nur am Code
abgelesen.

## Befund 1: Fotos werden nicht zuverlässig gefunden

Für 14409 wurden keine Bilder gefunden, obwohl das Gutachten-PDF (13 Seiten)
mehrere Fotos enthält, die der aktuelle Filter (`server/utils/extract/pdf-images.ts`,
`filterImages()`) nachweislich akzeptieren würde (S.10: 668×465px ×2, S.11:
444×608px, S.12: 667×393px — alle > minWidth/minHeight, keine Quadrat-Ausreißer).
Der Filter selbst ist also nicht die Ursache.

Die eigentliche Ursache liegt in [server/tasks/enrich.ts](../../server/tasks/enrich.ts)
(ca. Zeile 377-448): Sobald für eine Auktion **irgendein** Cache-Eintrag
existiert, greift der `if (priorEntry)`-Zweig, der `priorEntry.photos` einfach
weiterreicht — die eigentliche Foto-Pipeline (`downloadNativeImages`/
`extractPdfPhotos`) läuft nur im `else`-Zweig, also nur beim allerersten
Enrichment. Anders als bei LLM-Feldern (`needsLlmFieldsBackfill`) gibt es
**keinen Backfill/Retry-Mechanismus für Fotos**. Schlug der erste Versuch aus
irgendeinem (auch transienten) Grund fehl — Netzwerk-Hänger beim PDF-Fetch,
älterer/strengerer Filter-Stand, ein seither behobener Bug — bleibt der
Auktions-Eintrag für immer ohne Fotos, auch wenn ein erneuter Versuch heute
welche fände.

**WP-1: Foto-Backfill-Mechanismus — umgesetzt in [PR #156](https://github.com/haexhub/zvg-immo/pull/156)**
- Neues Feld auf `AuctionExtraction`/`ExtractionCache`, das unterscheidet
  zwischen "Fotos nie versucht" und "versucht, keine gefunden" (analog zu
  `condition === undefined` vs. `null` bei den LLM-Feldern) — `photosCheckedAt: string | undefined`.
- `needsPhotoBackfill(a)`-Prädikat (analog `needsLlmFieldsBackfill`) nimmt
  Einträge ohne `photosCheckedAt` in die `eligible`-Liste auf, begrenzt durch
  einen Failure-Counter (`photoFailures`, analog `MAX_LLM_FAILURES`), damit ein Listing mit
  echt fehlenden Fotos nicht bei jedem Run erneut probiert wird.
- Kein separater Einmal-Lauf nötig: bestehende Cache-Einträge ohne den neuen
  Marker gelten automatisch als "nie versucht" und laufen beim nächsten
  regulären Enrich-Run durch die Backfill-Prädikat-Logik.
- Akzeptanzkriterium: 14409 bekommt beim nächsten Enrich-Run entweder Fotos
  (falls die Extraktion erfolgreich ist) oder einen erhöhten `photoFailures`-
  Zähler nach einem fehlgeschlagenen, aber protokollierten Versuch — kein
  stiller "für immer keine Fotos"-Zustand mehr. Ein Nachweis-Test
  (`enrich`-Unit-Test) belegt, dass ein Eintrag mit `photos: undefined` und
  fehlendem `photosCheckedAt` erneut die Foto-Pipeline durchläuft, einer mit
  gesetztem Marker nicht.

## Befund 2: Bilder teilweise verdreht

`pdfimages` (poppler) extrahiert die eingebetteten Raster-Bilder exakt so, wie
sie im PDF gespeichert sind — **ohne** die Rotations-/Transformationsmatrix des
Content-Streams anzuwenden, mit der die Seite das Bild beim Rendern platziert
und dreht. Wurde ein gescanntes Bild vom Erstellungswerkzeug über eine
Seiten-Transformationsmatrix gedreht platziert, kommt die rohe Extraktion in
falscher Orientierung heraus. `pdfimages -list` liefert dafür keinerlei
Rotations-Metadaten — das ist keine Fehlkonfiguration, sondern eine
grundsätzliche Grenze des aktuellen Extraktionswegs (rohes XObject statt
gerenderte Darstellung).

Zwei mögliche Lösungsrichtungen, beide mit nicht-trivialem Aufwand:
- **(a) Seiten-Rendering + Crop**: Seite per `pdftoppm` rendern (respektiert
  Rotation korrekt) und die Foto-Region anhand von Positionsdaten (z.B.
  `pdftohtml -xml` liefert Bounding-Boxes pro Bild-Element) ausschneiden, statt
  das rohe XObject zu nehmen. Muss noch geprüft werden, ob `pdftohtml -xml`
  tatsächlich zuverlässig Positionen für eingebettete Rasterbilder liefert.
- **(b) Werkzeugwechsel**: Eine Bibliothek nutzen, die die CTM (Current
  Transformation Matrix) pro Bild direkt exponiert (z.B. PyMuPDF/mutool) —
  neue Systemabhängigkeit, größerer Eingriff in den bestehenden
  poppler-CLI-Ansatz.

**WP-2: Rotation — Spike-Ergebnis: (a) verworfen, (b) zurückgestellt.**

Spike durchgeführt (2026-07-24): das echte Gutachten.pdf zu 14409 live von
zvg-portal.de geladen (20 Seiten, Fall bestätigt) — enthält zufällig keine
sichtbar rotierten Fotos, taugt also nicht als Gegenbeispiel. Zusätzlich zwei
synthetische Test-PDFs gebaut (ein Foto, per Content-Stream-CTM um 90° in
beide Richtungen gedreht platziert — exakt das oben beschriebene Szenario)
und alle drei Werkzeuge verglichen:

- `pdftoppm` rendert die Rotation korrekt (visuell per Farb-Sampling an vier
  Referenzpunkten verifiziert).
- `pdfimages -list` liefert wie erwartet die rohen, ungedrehten Maße.
- `pdftohtml -xml` liefert für **beide** getesteten Rotationsrichtungen
  unbrauchbare Bounding-Boxes — negative Breiten/Höhen, teils Koordinaten
  außerhalb der Seite. Kein Rundungsfehler, sondern ein systematischer
  Aussetzer bei Matrizen mit a=d=0 (reine 90°/270°-Drehung).

**Damit ist Option (a) verworfen** — pdftohtml -xml liefert für genau den
Rotationsfall, den es lösen soll, unbrauchbare Positionsdaten. Es bliebe nur
Option (b) (PyMuPDF/mutool), was eine neue Abhängigkeit außerhalb des
bestehenden Node/poppler-CLI-Stacks bedeutet (inkl. Deployment-Aufwand im
separaten ansible-Repo).

**Entscheidung (Nutzer, 2026-07-24): zurückgestellt.** Kein Code-Change.
Begründung: unklar, wie oft rotierte Fotos in der Praxis tatsächlich
auftreten (das 14409-Beispiel selbst hatte keine) — Aufwand/Nutzen einer
neuen Systemabhängigkeit soll erst mit mehr Datenbasis bewertet werden. Bei
Bedarf später erneut aufgreifen, dann direkt mit Option (b) planen (Option
(a) ist durch den Spike ausgeschlossen).

## Befund 3: Kein Verkehrswert/Bodenrichtwert für DE

- **Bodenrichtwert** existiert bereits als Feld (`insights.landValueEurPerSqm`
  in `server/utils/extract/llm.ts`) — wird also grundsätzlich vom Prompt
  erfragt, kommt aber bei Haiku offenbar nicht zuverlässig durch (siehe
  Befund 4).
- **Verkehrswert** (Gesamt-Schätzwert) hat für DE/zvg-portal **überhaupt
  keinen Extraktionspfad** — weder strukturell noch per LLM. Der bestehende
  `verkehrswert-cache.ts`/`server/tasks/geocode.ts` deckt ausschließlich
  `at-edikte` und `biddit` ab (`enrichAtVerkehrswert`/`enrichBidditVerkehrswert`);
  zvg-portal wurde dort nie angebunden. Das ist keine Regression, sondern ein
  fehlendes Feature — deutsche Gutachten nennen den Verkehrswert in aller Regel
  explizit im Text, es fehlt schlicht ein Feld + Prompt-Anweisung dafür.

**WP-3: Verkehrswert-Extraktion für DE** — **UMGESETZT** (PR #158).
- Neues Feld `marketValueEur`/`marketValueText` im `EXTRACTION_SCHEMA`/
  `ClampedExtraction`, Prompt-Ergänzung.
- Präzedenz beim Zusammenführen: `applyExtractionToAuctions` füllt
  `Auction.marketValueEur` nur, wenn noch keiner strukturell gesetzt ist
  (AT-Edikte/Biddit über `verkehrswert-cache.ts` gewinnen immer).

## Befund 4: Falscher Wert bei "250 Zimmer" (Hotel-Genehmigung ≠ existierendes Hotel)

Bestätigt: `resolveLlmConfig()` in `server/utils/extract/llm.ts` (Zeile 492)
fällt ohne explizite Admin-Konfiguration auf `claude-haiku-4-5` zurück. Der
Fehler selbst — eine genehmigte Bebauungs-Kapazität (bis zu 250
Hotelzimmer laut Baugenehmigung) mit einer tatsächlichen, existierenden
Zimmerzahl zu verwechseln, obwohl das Hotel noch gar nicht gebaut ist — ist ein
Verständnisfehler, den ein stärkeres Modell wahrscheinlich vermeidet, den man
aber zusätzlich durch eine explizite Prompt-Klarstellung absichern sollte,
unabhängig vom Modell.

**WP-4: Extraktionsqualität** — **UMGESETZT** (PR #157).
- Prompt-Ergänzung in `SYSTEM_PROMPT`: Zimmeranzahl nur für tatsächlich
  existierende Bebauung, nicht für genehmigte/mögliche/zulässige Kapazität aus
  Bebauungsplan oder Baugenehmigung.
- Modellwechsel: Admin-Empfehlung in den LLM-Provider-Settings auf ein
  Sonnet-Modell angehoben; der Code-Default in `resolveLlmConfig()` bleibt
  bewusst `claude-haiku-4-5` als Sicherheitsnetz für unkonfigurierte
  Deployments (Nutzer-Entscheidung: keine automatische ~3x-Kostensteigerung
  für bestehende Installationen).

## Reihenfolge

WP-1 und WP-3 sind eigenständig umsetzbar und klar geschnitten. WP-4 ist ein
kleiner, schneller Fix. WP-2 braucht zuerst einen Spike, bevor der eigentliche
Umfang feststeht. Umsetzung: WP-1 → WP-4 → WP-3 als eigene PRs (#156, #157,
#158); WP-2-Spike durchgeführt, Ergebnis siehe oben — zurückgestellt.
