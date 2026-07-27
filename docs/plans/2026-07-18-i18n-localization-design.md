# Internationalisierung & Lokalisierung (Sprache + Währung) — Design

**Status (2026-07-23): umgesetzt.** Baustein A (UI DE+EN) via PR #94, Baustein C
(Nutzerwährung) via PR #96+#97, Baustein B (Content-Übersetzung) via PR #98 —
alle gemergt.

## Context

Zielbild: **internationales Produkt** — Nutzer aus jedem Land nutzen die Seite in *ihrer
Sprache* und *ihrer Währung*, unabhängig davon, in welchem Land die Auktion liegt (Beispiel:
schwedischer Nutzer sucht Grundstücke in Deutschland → sieht die Auktion auf Schwedisch,
filtert/rechnet in SEK, Umrechnung live). **Start-Scope für Übersetzung: nur DE + EN.**
Währung: alle (über Kurse), nicht auf DE+EN begrenzt.

Kein Code hier — Umsetzung pro Phase im eigenen Worktree (`EnterWorktree`).

„International" bündelt **drei getrennte Bausteine** mit sehr unterschiedlichem Aufwand:

| | Baustein | Aufwand | Baut auf |
|---|---|---|---|
| **A** | UI-Oberfläche in Nutzersprache (Chrome/Labels) | moderat | Terminologie-Label-Schicht |
| **B** | Übersetzung der Auktions-*Inhalte* (Freitext) | groß (Kostentreiber) | LLM (Summary-Muster) + G1-content_hash |
| **C** | Anzeige/Filter in Nutzerwährung, Live-Umrechnung | moderat | Terminologie Phase B (`marketValue`+`currency`) |

### Getroffene Entscheidungen (Nutzer)
- Start-Übersetzungsziele: **DE + EN**.
- Content-Übersetzung: **LLM (Claude, wie `summary.post.ts`)**, **on-demand + Cache**.
- Sprache und Währung: entkoppelt (unabhängige Einstellungen).

### Abhängigkeit zum Terminologie-Refactor
**Terminologie Phase A (Rename) bleibt der erste Schritt** — er liefert die neutrale Basis, auf
der die i18n-Label-Schicht (A) sitzt. **Terminologie Phase B** (`marketValue`+`currency`+
abgeleitetes `marketValueEur`) ist die **Voraussetzung für C**. Reihenfolge:
`Terminologie A → Terminologie B → {i18n-A + C} → i18n-B`.

## Baustein A — UI-Oberfläche (DE + EN)

- **`@nuxtjs/i18n`** (vue-i18n) mit Locale-Dateien `de`/`en`. Erster i18n-Layer im Projekt.
- **Label-Schicht aus dem Terminologie-Refactor:** neutrale Code-Namen → lokalisierte Labels.
  Betrifft insb. Enum-/Kategorie-Anzeigen, die *nicht* übersetzt werden müssen, sondern
  gemappt: `propertyType` (Objektart-Enum), `AttachmentKind`
  (`announcement`/`appraisal`/`brochure`/…), Filter-Labels, Regions-/`authority`-Kategorien.
- **Locale-Ermittlung:** Default aus `Accept-Language`, expliziter Umschalter, persistiert —
  im Account (`locale`-Preference) für Eingeloggte, sonst Cookie.
- **SSR-Cache:** Seite variiert **nach Locale** → Locale in den Cache-Key. (Währung bewusst
  NICHT, siehe C.)

## Baustein B — Content-Übersetzung (Freitext)

**Übersetzungs-Fläche bewusst klein halten:**
- Übersetzt werden **nur `title` + `description`** (Freitext in Quellsprache).
- **Nicht** übersetzt: strukturierte Felder (`propertyType`, Flächen, `rooms` — via Label-
  Schicht A gerendert), Eigennamen (`authority`-Name, `address`, Ort).

**Architektur (spiegelt `summary.post.ts`):**
- Endpoint `server/api/auction/[platform]/[id]/translation.post.ts?lang=<target>` — gleiche
  Bausteine wie Summary: Cache-First, `inflight`-Dedup, `MAX_INFLIGHT`, In-Memory-Rate-Limit,
  Snapshot-Lookup, `isSafePathSegment`.
- **Cache-Key `(content_hash, target_lang)`** — `content_hash` über die kanonische
  Freitext-Payload (`title`+`description`). **Derselbe Änderungs-Schlüssel wie im G1-Archiv**:
  ändert sich der Inhalt, ändert sich der Hash → neue Übersetzung; unveränderter Inhalt →
  Cache-Treffer, kein LLM-Call. Immutabel pro Hash → keine Invalidierung nötig.
- **Speicher: Postgres-Tabelle** `content_translations(content_hash, lang, title, description,
  at)` statt Disk-JSON — durabel, redeploy-fest, gebackupt, queryable. (Weicht bewusst vom
  Disk-Cache der Summary ab, jetzt wo Postgres steht; Summary kann später nachziehen.)
- **Passthrough-Regel:** Quellsprache aus einer `country → primary-language`-Map. Ist
  Ziel == Quelle (DE-Auktion, Ziel DE; UK/US-Auktion, Ziel EN) → **kein LLM-Call**, Original
  durchreichen.
- **Prompt:** wörtlich/treu übersetzen, keine Ausschmückung, Immobilien-/Rechtsbegriffe
  erhalten, reine Übersetzung ausgeben (kein Prosa-Vorspann) — analog zur Summary-Disziplin.
- **Frontend:** Objektseite + Karten lazy per POST (wie die Summary); zeigt bei Bedarf
  „automatisch übersetzt"-Hinweis.

```sql
CREATE TABLE IF NOT EXISTS content_translations (
  content_hash text NOT NULL,
  lang         text NOT NULL,
  title        text,
  description  text,
  at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, lang)
);
```

**Skalierung:** on-demand → nur tatsächlich angesehene Inhalte werden übersetzt; neue Sprache
= einfach neuer `target_lang`, kein Volllauf, kein Code. Haiku-günstig. Kein Silent Cap, aber
das Rate-Limit/`MAX_INFLIGHT` schützt vor Call-Stürmen beim Cold Start.

## Baustein C — Nutzerwährung + Live-Umrechnung

Erweiterung von Terminologie Phase B, **kein Redesign**:
- Speicher (aus Terminologie B): `marketValue`+`currency` (Wahrheit) + `marketValueEur`
  (interne Vergleichsbasis).
- **Anzeige client-seitig konvertieren:** eine Kurs-Tabelle (`EUR → *`) einmal laden, im
  Browser `marketValueEur → Nutzerwährung`. **Damit variiert die Seite NICHT nach Währung** →
  keine SSR-Cache-Explosion (die Falle). Anzeige zeigt Original (`marketValue`+`currency`) +
  konvertierten Nutzerwert transparent (die Versteigerung findet in der Originalwährung statt).
- **Filter:** Nutzer gibt Grenzen in seiner Währung ein → Konvertierung → Query gegen
  `marketValueEur`.
- **„Live" = periodisch frische Kurse**, nicht Echtzeit-Ticks pro Request: `exchange-rate.ts`
  erweitern (stündlich/täglich refreshen, Kurs-Tabelle an den Client ausliefern). Für
  Immobilien-Listings ausreichend und vermeidet Kosten/Cache-Explosion.
- **Währungs-Ermittlung:** Default aus Locale/Geo, expliziter Umschalter, persistiert —
  **unabhängig von der Sprache** (ein Schwede darf Schwedisch + EUR wählen).

## Architektur-Fallen (bewusst adressiert)

1. **Cache-Explosion Sprache × Währung** → Währung client-seitig umrechnen; nur Sprache
   variiert server-seitig.
2. **Sprache/Währung koppeln** → zwei unabhängige Preferences mit je eigenem Default.
3. **Übersetzungskosten** → on-demand + `(content_hash,lang)`-Cache + Passthrough bei
   Ziel==Quelle; nur Freitext, nicht Struktur/Eigennamen.

## Phasierung

1. **i18n-A (UI DE+EN)** — `@nuxtjs/i18n`, `de`/`en`-Locales, Label-Schicht verdrahten,
   Locale-Umschalter + Persistenz, Locale im SSR-Cache-Key. Setzt Terminologie A voraus.
2. **C (Nutzerwährung)** — `exchange-rate.ts`-Erweiterung + Client-Konvertierung + Währungs-
   umschalter + Filter-Konvertierung. Setzt Terminologie B voraus.
3. **i18n-B (Content-Übersetzung)** — `content_translations`-Tabelle, `translation.post.ts`,
   Passthrough-Map, Frontend-Lazy-Load. Der große Workstream; unabhängig von A/C lauffähig.

## Verifikation

- **i18n-A:** UI in DE und EN vollständig; Objektart/AttachmentKind-Labels korrekt gemappt
  (nicht übersetzt); Umschalten persistiert über Reload; SSR liefert die richtige Sprache.
- **C:** Schwedischer Nutzer (SEK) sieht ein DE-Objekt mit Original (€) + SEK-Wert; `priceMin/
  Max` in SEK filtert korrekt über `marketValueEur`; Seite ist nach Währung **nicht**
  separat gecacht (Client-Konvertierung). Kurse werden periodisch aktualisiert.
- **i18n-B:** DE-Objekt mit Ziel EN → EN-Übersetzung von title/description, zweiter Aufruf
  trifft Cache (kein zweiter LLM-Call, per Log). Ziel DE → Passthrough, kein Call.
  Inhaltsänderung (neuer `content_hash`) → neue Übersetzung. Strukturfelder/Eigennamen bleiben
  unübersetzt.
- Typecheck/Test grün halten; Vitest für Passthrough-Map + `(content_hash,lang)`-Cache-Logik.

## Explizit nicht Teil
- Weitere Sprachen über DE+EN hinaus zum Start (Architektur erlaubt sie ohne Code, aber
  Redaktions-/QA-Aufwand pro Sprache ist bewusst später).
- Übersetzung von Eigennamen/Adressen/`authority`-Namen.
- Menschliche Übersetzungs-Qualitätssicherung / Post-Editing (v1 ist rein maschinell mit
  „automatisch übersetzt"-Hinweis).
- Wechsel des Übersetzungs-Engines auf dedizierte MT (DeepL/Google) — Engine bleibt v1 der
  LLM; Austauschbarkeit wird nicht künstlich vorab abstrahiert (YAGNI), erst bei belegtem
  Qualitäts-/Kostenbedarf.
