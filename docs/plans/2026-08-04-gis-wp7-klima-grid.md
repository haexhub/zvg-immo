# WP-7 — Klima-Grid und Temperaturfilter

Datum: 2026-08-04
Teil von [GIS-Architektur](2026-08-04-gis-scaling-architecture.md). Abhängig von: [WP-5](2026-08-04-gis-wp5-precompute-suche.md).
Aufwand: 2–3 Tage. Repo: `zvg-immo`.

## Ziel

Die Suchanfrage „alle Grundstücke, die im Sommer eine Durchschnittstemperatur von 30 °C nicht übersteigen" — und weitere Klimakriterien (Winterkälte, Niederschlag, Frosttage) als Filter und als Teil der Lagebeschreibung.

## Der architektonische Unterschied zu allem anderen

Klima ist ein **kontinuierliches Feld**, kein diskretes Objekt. Es gibt keine „Entfernung zur nächsten Temperatur" — es gibt einen Wert, der an einem Ort gilt. Daraus folgt ein anderes Verfahren:

| | diskrete Objekte (WP-4/WP-5) | kontinuierliche Felder (dieses WP) |
|---|---|---|
| Frage | „wie weit zum nächsten?" | „welcher Wert gilt hier?" |
| Speicherung | Distanz pro Auktion | Wert pro Rasterzelle |
| Kosten | skaliert mit Auktionen | skaliert **nicht** mit Auktionen |

Das ist der entscheidende Punkt: Klimanormale sind auf ~9 km Raster definiert. Sie pro Auktion abzurufen wäre Verschwendung — hunderte Auktionen in derselben Region teilen exakt denselben Wert. Der Aufwand hängt an der Rasterfläche, nicht an der Auktionszahl, und bleibt damit gleich, ob 3 720 oder 5 Mio. Auktionen im System sind.

## Datenmodell

```sql
CREATE TABLE climate_cells (
  id        serial PRIMARY KEY,
  geom_3035 geometry(Polygon, 3035) NOT NULL,  -- 0,1°-Zelle, nach 3035 projiziert
  lat       numeric(6,3) NOT NULL,             -- Zellmittelpunkt, für den API-Abruf
  lng       numeric(6,3) NOT NULL,
  summer_tmax_avg_c numeric(4,1),   -- Mittel der Tageshöchstwerte Jun–Aug
  summer_tavg_c     numeric(4,1),
  winter_tavg_c     numeric(4,1),
  annual_precip_mm  int,
  frost_days        int,
  fetched_at        timestamptz,     -- NULL = Zelle angelegt, aber nie befüllt
  UNIQUE (lat, lng)
);
CREATE INDEX ON climate_cells USING GIST (geom_3035);
```

`auction_geo_metrics.climate_cell_id` (aus WP-5) bekommt jetzt den Fremdschlüssel. Die Suche wird damit:

```sql
JOIN climate_cells c ON c.id = m.climate_cell_id
WHERE c.summer_tmax_avg_c <= 30
```

`climate_cells` hat für Europa maximal ~150 000 Zeilen und liegt vollständig im Cache — der Join ist trivial.

**Welche Kennzahl für „Sommer-Durchschnittstemperatur"?** Bewusst zwei Spalten: `summer_tavg_c` ist der Tagesmittelwert, `summer_tmax_avg_c` das Mittel der Tageshöchstwerte. Der Nutzer, der „übersteigt 30 °C nicht" sucht, meint fast sicher die **Höchstwerte** — ein Tagesmittel von 30 °C wäre in Europa kaum irgendwo erreicht, und der Filter liefe leer. Im UI muss klar benannt sein, welche der beiden gefiltert wird; sonst wirkt das Ergebnis falsch.

## Datenquelle

**Open-Meteo Historical Weather API** (`/v1/archive`, ERA5-Land, 9 km, keyless). Gründe: das Projekt spricht Open-Meteo für Luftqualität schon an ([cams-air-quality.ts:38](server/utils/external-data/cams-air-quality.ts#L38)), es gibt das Konfigurations-Framework in [sources.ts](server/utils/external-data/sources.ts), und es braucht keinen Schlüssel.

Klimanormale werden aus einer Referenzperiode gemittelt (1991–2020). Pro Zelle ein Request mit `daily=temperature_2m_max,temperature_2m_mean,precipitation_sum` über den Zeitraum, oder — sparsamer — `monthly`-Aggregate, falls verfügbar. Das Antwortvolumen pro Zelle für 30 Jahre Tageswerte ist erheblich; hier lohnt es, zuerst mit **einer** Zelle zu prüfen, welche Aggregationsstufe die API liefert, bevor der Abrufpfad gebaut wird.

**Nur Zellen befüllen, in denen Auktionen liegen**, lazy beim ersten Bedarf. Bei 3 720 Auktionen sind das einige Dutzend bis wenige Hundert Zellen, nicht 150 000. Klimanormale veralten nicht — einmal geholt, nie wieder.

Für vollständige Abdeckung (z. B. ein Kartenlayer) gibt es zwei Bulk-Wege als Ausbaustufe: ein einzelner Request an den [Copernicus CDS](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land-monthly-means) für ERA5-Land-Monatsmittel, oder [Open-Meteos AWS-Open-Data-Bucket](https://github.com/open-meteo/open-data) (`s3://openmeteo`), dessen Chunk-Format punktweise Zugriffe ohne Vollabzug erlaubt. Beides erst, wenn es gebraucht wird.

## Schritte

1. **Migration** für `climate_cells` + FK auf `auction_geo_metrics` (Drizzle, [WP-2](2026-08-04-gis-wp2-drizzle-fundament.md)).
2. **Zellzuordnung:** Für jede geocodierte Auktion die 0,1°-Zelle bestimmen (Abrunden der Koordinaten auf 0,1° ist ausreichend und deterministisch), Zeile anlegen falls nicht vorhanden, `climate_cell_id` setzen. Gehört in denselben Job wie WP-5 — er kennt die Position schon.
3. **Adapter** im `sources.ts`-Rahmen, mit Rate-Limit-Behandlung. Aus der Projekthistorie: Rate-Limit-Fehler dürfen **nicht** wie echte Fehler gezählt werden, sonst sperren sie Datensätze dauerhaft; und Tageslimit-429 nicht endlos retrien.
4. **Befüll-Job** für Zellen mit `fetched_at IS NULL`.
5. **Suchfilter** `summerTempMax` in [auction-search-filters.ts](server/utils/auction-search-filters.ts), analog zu den Distanzfiltern aus WP-5.
6. **UI:** Slider in [SearchFilters.vue](components/search/SearchFilters.vue), Wert in der Lagebeschreibung.

## Verifikation

1. Ein einzelner API-Abruf für eine bekannte Zelle liefert plausible Werte — Referenzpunkt selbst wählen (z. B. Sizilien deutlich wärmer als Nordschweden). Ein Vorzeichen- oder Einheitenfehler (Kelvin statt Celsius) fällt sonst erst dem Nutzer auf.
2. Zellzuordnung stimmt: für 3 Auktionen die berechnete Zelle gegen die Koordinaten prüfen.
3. Zwei Auktionen in derselben Region teilen dieselbe `climate_cell_id` — das ist der Beweis, dass das Grid greift und nicht pro Auktion abgerufen wird.
4. `summerTempMax=30` liefert eine Teilmenge, und die ausgeschlossenen Objekte liegen nachweislich in wärmeren Regionen.
5. Zweiter Lauf des Befüll-Jobs macht keine API-Requests (alles `fetched_at` gesetzt).
6. `fetched_at IS NULL` ist von „Wert ist wirklich NULL" unterscheidbar — dieselbe Falle wie bei den Distanzmetriken.

## Fallstricke

- **Pro Auktion abrufen statt pro Zelle** → der ganze Vorteil ist weg, und bei europaweiter Skalierung wird es unbezahlbar. Das ist der Kernfehler, den dieses Design vermeidet.
- **Einheiten:** Open-Meteo liefert Celsius, ERA5 aus dem CDS Kelvin. Bei einem späteren Wechsel der Quelle ist das die erste Fehlerquelle.
- **Referenzperiode nicht dokumentiert** → Werte sind später nicht reproduzierbar. Periode in `sources.ts` als Attribution festhalten.
- **0,1°-Zellen sind nicht flächengleich** (in Nordskandinavien schmaler als am Mittelmeer). Für Klimawerte irrelevant, aber die Polygon-Geometrie in 3035 darf nicht als „quadratische Zelle" missverstanden werden.
- **Klimadaten sind Normale, keine Vorhersage.** In der UI klar benennen, sonst liest es sich als Wetterprognose.
- **Sommer-Definition:** Jun–Aug ist Nordhalbkugel-Konvention und für Europa richtig — als Kommentar festhalten, damit es bei einer Ausweitung nicht stillschweigend falsch wird.
