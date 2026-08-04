# WP-3 — Geocoding-Abdeckung von 1 % anheben

Datum: 2026-08-04
Teil von [GIS-Architektur](2026-08-04-gis-scaling-architecture.md). Abhängig von: **[WP-1](2026-08-04-gis-wp1-index-notfall.md) muss fertig sein.**
Aufwand: 2–3 Tage. Repo: `zvg-immo` (+ evtl. `ansible`).

## Warum

Auf Prod gemessen (2026-08-04):

| | Auktionen | mit Adresse | mit Koordinaten |
|---|---|---|---|
| DE | 3 275 | | 37 |
| BG | 348 | | 0 |
| SE | 97 | | 0 |
| **Summe** | **3 720** | **2 785** | **37 (1,0 %)** |

Jede Geo-Funktion — Umgebungsfilter, Karte, Lagebeschreibung, die gesamte Architektur dieses Plans — kann derzeit höchstens 37 Objekte erreichen. Das ist der funktionale Blocker; alles andere in diesem Plan optimiert etwas, das fast keine Daten hat.

**Reihenfolge-Warnung:** Wird die Abdeckung auf die 2 785 Auktionen mit Adresse gehoben, **steigt die Last der heutigen Umgebungssuche um Faktor 75** (16,6 s pro Auktion, gemessen). Dieses WP darf erst nach WP-1 laufen, sonst verschärft es den Ausfall dramatisch statt Nutzen zu bringen.

## Befund: zwei mögliche Ursachen

Der Datei-Cache auf Prod (`/app/.cache_zvg/geocode`, siehe [geocode.ts:17](server/utils/geocode.ts#L17)) enthält **30 909 Einträge, davon 12 496 mit `notFound`** — also rund 18 400 erfolgreiche Auflösungen. Dem stehen 37 Koordinaten in der Datenbank gegenüber. Diese Lücke ist der Kern des Problems und **muss vor allem anderen geklärt werden.** Zwei Hypothesen:

**(a) Persistenz greift nicht.** Die Ergebnisse landen im Cache, aber nicht in `auction_details.lat/lng`. PR #306 („Persist geocoded coordinates back into auction records", Commit `c727363`) sollte genau das tun. Zu prüfen: wirkt der Pfad nur bei `fetch=1`-Requests gegen [auctions-geo.get.ts](server/api/auctions-geo.get.ts), also nur wenn jemand die Karte öffnet? Dann würde nie ein Hintergrundlauf die Abdeckung aufbauen.

**(b) Cache passt nicht zu den aktuellen Adressen.** Der Cache-Key ist `sha1(country + ':' + query)` über die *normalisierte* Adresse. Ändert sich die Normalisierung (z. B. durch die BG-Adressmarker-Fixes), zeigen alle alten Einträge ins Leere. Die 30 909 Einträge wären dann Altlast vergangener Auktionen.

**Unabhängig davon fehlt dem Key die Identität des Erzeugers.** Er enthält weder den Geocoder-Provider noch eine Version der Normalisierung. Das wird beim Umstieg auf LocationIQ (unten) unmittelbar relevant: die 12 496 `notFound`-Einträge stammen vom öffentlichen Nominatim, teils von einer gebannten IP — nach dem Providerwechsel würden sie weiterhin Retries unterdrücken und Adressen dauerhaft als unauflösbar markieren, die LocationIQ auflösen könnte. Provider und Normalisierer-Version gehören in den Key (oder in den Eintrag, mit Invalidierung bei Abweichung). Ohne das ist der Providerwechsel wirkungslos für alles, was schon einmal fehlgeschlagen ist.

Erster Schritt dieses WP ist eine Entscheidung zwischen (a) und (b) — nicht Umsetzung. Vorgehen: eine Handvoll aktueller Adressen aus `auction_details` nehmen, den Cache-Key nachbilden und prüfen, ob die Datei existiert und einen Treffer enthält.

## Die eigentliche Blockade: der Geocoder

[geocode.ts:23-26](server/utils/geocode.ts#L23-L26) wählt den Backend:

```ts
const LOCATIONIQ_KEY = process.env.LOCATIONIQ_API_KEY ?? ''
const GEOCODER_BASE = LOCATIONIQ_KEY
  ? (process.env.LOCATIONIQ_ENDPOINT ?? 'https://eu1.locationiq.com/v1/search')
  : 'https://nominatim.openstreetmap.org/search'
```

Auf Prod ist **`LOCATIONIQ_API_KEY` nicht gesetzt** (im Container geprüft). Es läuft also gegen das öffentliche `nominatim.openstreetmap.org` mit 1,1 s Mindestabstand ([MIN_GAP_MS](server/utils/geocode.ts#L31)) — und die Server-IP ist dort blockiert (429). Nach 5 Fehlern greift ein 15-Minuten-Cooldown, was den Durchsatz weiter gegen null drückt.

Bei 1,1 s pro Anfrage bräuchten 2 785 Adressen im Idealfall ~51 Minuten. Mit Ban und Cooldown: nie.

Der Code ist für die Lösung **schon vorbereitet** — es fehlt nur die Konfiguration. Zwei Optionen:

| | LocationIQ-Key setzen | Nominatim selbst hosten |
|---|---|---|
| Aufwand | Minuten (ENV-Variable) | Tage (Container, Import, ~100 GB) |
| Kosten | Free-Tier 5 000/Tag, darüber kostenpflichtig | Serverressourcen |
| Rate-Limit | eigene Quote, kein Shared-IP-Ban | keines |
| Europaweite Skalierung | Kostenfaktor | einmalige Investition |

**Empfehlung: zuerst LocationIQ.** Es ist eine ENV-Variable, der Code unterstützt es bereits, und 5 000/Tag deckt die aktuellen 2 785 Adressen in einem Lauf. Selbst-Hosting erst, wenn die Auktionszahl europaweit wächst — dann ist es die richtige Antwort, aber nicht heute. Die ENV-Variable gehört ins Quadlet-Unit im ansible-Repo; ein `.env.j2`, das nicht gelesen wird, war dort schon einmal die Ursache eines vermeintlich gesetzten Werts.

## Weitere Schritte

### Wiederholte Fehlversuche nicht ewig wiederholen

12 496 `notFound`-Einträge sind ein Signal: viele Adressen sind grundsätzlich nicht auflösbar (Flurstücksbezeichnungen ohne Straße, „Gemarkung X Flur Y"). Der Cache unterdrückt Retries schon korrekt. Für die Suche wichtiger ist, „nie versucht" von „versucht, nicht auflösbar" **in der Datenbank** unterscheidbar zu machen — sonst kann kein Backfill-Job wissen, was noch offen ist. Heute steht diese Information nur im Dateisystem.

Vorschlag: ein `geocode_attempted_at` und `geocode_result`-Feld an der Auktion (via Drizzle-Migration, [WP-0](2026-08-04-gis-wp0-schema-neuaufbau.md)). Damit wird der Fortschritt messbar und der Backfill idempotent. Der Provider gehört mit hinein — sonst ist nach dem Wechsel auf LocationIQ nicht unterscheidbar, welche Fehlversuche vom gebannten Nominatim stammen und welche echte Nicht-Adressen sind.

### Backfill-Lauf

Ein Task, der alle Auktionen mit Adresse und ohne Koordinaten durchgeht. Bestehendes Muster: [server/tasks/geocode.ts](server/tasks/geocode.ts).

Randbedingungen, die aus der Projekthistorie kommen:
- **Eigener Connection-Pool mit hartem Limit.** Ein Ad-hoc-Container hat am 2026-08-03 durch Connection-Erschöpfung einen Prod-Totalausfall verursacht.
- **Abbruch-Signal beachten** — bei PR #306 fehlte das Abort-Signal, sodass der Lauf nach dem Request weiterlief.
- **Fortschrittszähler dürfen No-ops nicht mitzählen** (derselbe Fehler in PR #306): „persisted" muss echte Schreibvorgänge zählen.

### BG- und SE-Adressen

BG hat 0/348 geocodiert. Die bulgarischen Adressmarker (`гр.`, `с.`, `ул.`, `бул.`, `кв.`, `№`) brechen Nominatim-Queries — dafür existiert PR #256. Vor dem Backfill prüfen, ob der gemergt ist; sonst produziert der Lauf 348 `notFound`-Einträge, die künftige Versuche unterdrücken.

SE hat 0/97. Ursache separat prüfen — es kann dasselbe Ban-Problem sein oder ein Adressformat-Thema.

## Verifikation

1. Hypothese (a) oder (b) ist mit Belegen entschieden und dokumentiert.
2. Ein einzelner Geocode-Request gegen den konfigurierten Backend liefert 200, nicht 429.
3. Nach dem Backfill: `count(*) FILTER (WHERE lat IS NOT NULL)` deutlich über 37 — Zielgröße orientiert an den 2 785 mit Adresse, minus der nachweislich unauflösbaren.
4. Die Zahl der `notFound`-Fälle ist begründet, nicht bloß hingenommen: eine Stichprobe von 10 zeigt, dass es echte Nicht-Adressen sind.
5. Suchlaufzeit nach dem Backfill: die Umgebungsfilter dürfen sich nicht verschlechtert haben — hier zahlt sich WP-1 aus. Wenn die Laufzeit einbricht, ist das der Beweis, dass WP-5 gebraucht wird.

## Fallstricke

- **Ohne WP-1 ausführen** → Faktor 75 mehr Last auf einer Query, die den Server schon umlegt.
- **Cache-Verzeichnis ist containerlokal** (`/app/.cache_zvg`). Ohne Volume ist die Arbeit nach einem Redeploy verloren. Prüfen, ob ein Volume gemountet ist — 30 909 Einträge legen nahe, dass es eines gibt, aber das ist keine Bestätigung.
- **Koordinaten liegen auf `auction_details`, nicht `auctions`** (verifiziert: `auctions` hat keine lat/lng-Spalten) und sind damit **versioniert**. Eine neue Details-Version ohne mitgeführte Koordinaten setzt die Abdeckung still zurück. Das ist der wahrscheinlichste Mechanismus hinter Hypothese (a) und muss geprüft werden.
- **Nominatim-Policy:** identifizierender User-Agent ist Pflicht und bereits gesetzt ([UA](server/utils/geocode.ts#L28)). Bei LocationIQ nicht relevant, aber nicht entfernen.
