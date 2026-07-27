# Backlog-Roadmap (Phase 2) — Monetarisierung, Produkt/USP, Daten

Die erste Roadmap (`2026-07-18-execution-roadmap.md`, WP-1…8: Terminologie, Roh-Archiv,
i18n) ist **komplett gemergt**. Diese Roadmap zerlegt den bewusst zurückgestellten Backlog in
session-große Arbeitspakete (**WP-9…18**), gleiche Konvention: eigener Worktree
(`EnterWorktree`), endet grün (`tsc` + `pnpm test`), Review-/Auto-Merge nach Hybrid-Policy.

**Referenz-Design:** Produkt-Features stammen aus `~/.claude/plans/zvgscout-competitor-delta.md`
(F1–F8). Für Billing gibt es noch **kein** Design-Doc — WP-9 beginnt daher mit einem kurzen
Design-Spike (Stripe-Produktmodell).

**Nicht-technische Voraussetzungen (Flag):** Billing berührt Steuer/Rechnungsstellung/USt und
die Anwalts-Verträge; G3-B und F8 haben rechtliche Dimensionen (DSGVO, ToS der Quellen). Diese
Entscheidungen liegen beim Betreiber, nicht im Code — vor dem jeweiligen WP klären.

## Abhängigkeits-Graph

```
Strang M (Monetarisierung):
  WP-9 Billing-Fundament ──┬── WP-10 Premium-Abos + Gating
                           ├── WP-11 Anwalts-Provisions-Einzug
                           └── WP-12 API-Kontingent-Abrechnung
  WP-19 Finanzierungs-Referral ── unabhängig von WP-9 (Affiliate über Partnerprogramm)

Strang P (Produkt/USP) — untereinander & von M unabhängig, parallelisierbar:
  WP-13 KI-Analyse (F1+F2) ── WP-18 Archiv-Reprocessing
  WP-14 Karten POI+Messen (F4+F5)
  WP-15 Flurstück-WMS (F3)
  WP-16 Nutzer-Statistik (F6)

Strang D (Daten):
  WP-17 hanmark-Crawler (F8) — nach Quellen-Spike
```
Die drei Stränge sind unabhängig → können parallel laufen (Worktree-Isolation). Innerhalb von
M ist WP-9 der Flaschenhals.

---

## Strang M — Monetarisierung (die kommerzielle Lücke G4)

Heute *erfassen* alle drei Säulen nur (dongarra: `lawyer_inquiries.commission_*`,
`api_usage`), *ziehen* aber nichts ein. Dieser Strang schaltet echten Umsatz frei.

### Provider-Wahl (MoR vs. PSP) — die erste Entscheidung, NICHT vorab gesetzt
**Kernunterschied:** ein **Merchant of Record (MoR)** trägt VAT/Steuer weltweit (Berechnung,
Einzug, Abführung, Meldung) + Rechnungs-Compliance + Chargeback-Haftung; bei einem reinen
**Payment Processor** bist *du* MoR und schuldest EU-OSS-VAT selbst. Für int'l/EU-first-B2C
spricht viel für MoR bei den Consumer-Abos (kein grenzüberschreitender VAT-Aufwand ab Verkauf 1).
**Die drei Ströme sind aber verschieden** → nicht ein Modell für alles:
- **WP-10 Consumer-Abos** → MoR ideal.
- **WP-11 Anwalts-Provision** → B2B-Debitoren-/AR-Flow (*du* stellst Partnern Rechnung). **Kein
  MoR-Use-Case** — plain-Stripe-Invoicing bzw. anfangs manuelle/SEPA-Rechnung.
- **WP-12 API-Kontingent** → usage-based/metered.

**Verifiziert (Juli 2026):** Stripe hat inzwischen **Stripe Managed Payments** (MoR, aus der
Lemon-Squeezy-Übernahme, seit Feb 2026, ~35 Länder inkl. Westeuropa) — **transaction-level MoR**
(`managed_payments.enabled` pro Checkout-Session). Damit lässt sich der Split **nativ in einem
Anbieter** abbilden: MoR an auf Consumer-Abos, aus auf B2B-/API-Transaktionen — eine Integration,
ein Webhook-Stack. → **Leitkandidat.** **Alternative:** **Paddle** (standalone-MoR, 5 %+50¢
~7 % eff., länger erprobt) — wählen, wenn Bewährtheit > Stack-Einheitlichkeit oder SMP-Konditionen/
Abdeckung bei Eval nicht passen. **Lemon Squeezy: raus** (wird in Stripe Managed Payments überführt).
**Gebühren-Range:** plain Stripe ~2,9 %+30¢ + Zuschläge; SMP ~5 %+50¢ (evtl. ~6,4 % eff.,
unbestätigt); Paddle ~5 %+50¢ (~7 % eff.). Faustregel: MoR bis ~50–100k $ MRR, danach eigener-MoR.
**WP-9-Spike verifiziert die echten aktuellen SMP-Konditionen/EU-Abdeckung/Reife gegen Paddle.**

### WP-9 — Billing-Fundament (Provider-Auswahl + Zahlungs-Rails)
**Ziel:** Anbieter je Strom entscheiden und die Rails legen — noch kein Umsatzstrom.
**Scope:** **Design-Spike zuerst** = Provider-Entscheidung (MoR Paddle vs. PSP Stripe vs.
Split, siehe oben; aktuelle Konditionen/Feature-Reife verifizieren) → eigenes Design-Doc
`docs/plans/<datum>-billing-design.md`. Dann provider-**agnostische** Plumbing: Customer-Verknüpfung
an `auth.users`, Webhook-Endpoint mit Signaturprüfung + idempotenter Event-Verarbeitung,
Billing-Spiegel-Tabellen (Customer, Subscription/Invoice) in `schema.sql`, Secrets in `.env`.
Provider-SDK hinter einer dünnen internen Schnittstelle kapseln, damit ein Split (bzw. späterer
Wechsel) die Konsumenten WP-10/11/12 nicht anfasst.
**Abhängigkeit:** dongarra-Auth (da). **Blockiert** WP-10/11/12.
**Akzeptanz:** Test-Mode-Checkout legt einen Customer an, Webhook signaturgeprüft + idempotent
(Doppel-Event = kein Doppel-Effekt); ohne Billing-Config No-Op/kein Crash. `tsc`+Tests grün.

### WP-10 — Premium-Abos + Feature-Gating
**Ziel:** wiederkehrende Nutzer-Abos + `isPremium`-Gate.
**Scope:** Abo-Pläne (Checkout des gewählten **MoR**-Providers), Subscription-Status aus Webhooks
pflegen, serverseitiges `isPremium(user)`; erste gegatete Features (z.B. unbegrenzte Alerts,
erweiterte Statistik, später F7 Google/StreetView); Account-UI (Plan, Kündigen via Provider-Portal).
**Provider-Hinweis:** dies ist der Consumer-B2C-Strom → **MoR (Paddle)** übernimmt hier die
grenzüberschreitende VAT — der Hauptgrund für MoR.
**Abhängigkeit:** WP-9. **Akzeptanz:** Nutzer bucht Test-Abo → `isPremium` true → gegatetes
Feature sichtbar; Kündigung/Ablauf via Webhook → wieder gegated. Kein Feature-Leak an
Nicht-Premium.

### WP-11 — Anwalts-Provisions-Einzug
**Ziel:** die schon erfassten Leads (`lawyer_inquiries.commission_cents`) abrechnen.
**Scope:** Status `pending→invoiced→paid` real treiben (Rechnung pro Anwalt/Periode aus den
Lead-Zeilen — **B2B-AR, kein MoR**: Stripe-Invoicing oder anfangs manuelle/SEPA-Rechnung);
Admin-Ansicht unter `/settings` (offene Beträge je Anwalt); `waived`-Pfad.
**Abhängigkeit:** WP-9. **Akzeptanz:** Leads einer Periode erzeugen genau eine Anwalts-Rechnung
mit korrekter Summe; bezahlte Invoice setzt `paid`; keine Doppelabrechnung (Idempotenz).

### WP-12 — API-Kontingent-Abrechnung
**Ziel:** `api_usage`-Tageszähler monetarisieren.
**Scope:** Tarif (Freikontingent + metered darüber), metered/usage-report des gewählten
Providers aus `api_usage`;
Quota-Anzeige im Account (Self-Service-API-Keys existieren aus dongarra Phase 5).
**Abhängigkeit:** WP-9. **Akzeptanz:** simulierte Nutzung über Freikontingent → korrekter
metered-Betrag; Anzeige stimmt mit `api_usage` überein.

### WP-19 — Finanzierungs-Referral (nur Affiliate-Links, KEINE Beratung)
**Ziel:** dritte Einnahmequelle — kontextuelle Affiliate/Referral-Links zu einem **lizenzierten
Finanzierungspartner**, vergütet über dessen Partnerprogramm. **Bewusst nur Referral-Links,
kein Beratungs-/Vermittlungs-Flow** (Nutzer-Entscheidung) → bleibt Werbung/Lead-Gen, **kein
§34i-GewO-Aufwand**.
**Scope:** kontextueller CTA auf der Objektseite (ggf. auch Liste) „Finanzierung für dieses
Objekt?" → Affiliate-Link zum Partner mit Affiliate-Tag; wenn das Partnerprogramm es erlaubt,
Objekt-Kontext (Verkehrswert/Ort) als URL-Param im Deep-Link. **Keine Finanzdaten-Erfassung,
kein On-Platform-Formular, keine Beratung.** Optional: eigenes Klick-Tracking für die
Conversion-Messung.
**Abhängigkeit:** **KEIN WP-9** (Affiliate-Vergütung läuft über den Partner, nicht über die
eigenen Billing-Rails) → unabhängig/früh machbar. **Gated auf:** (a) lizenzierter
Finanzierungspartner mit Affiliate-Programm, (b) kurzer Rechts-Check, dass die konkrete
Umsetzung (v.a. objekt-kontextualisierte Links) Werbung bleibt und nicht als Empfehlung/
Vermittlung gewertet wird.
**Akzeptanz:** Objektseite zeigt den kontextuellen Finanzierungs-Link mit korrektem
Affiliate-Tag; Klick landet beim Partner; keine Finanzdaten erfasst; (optional) Klick wird
gezählt.
**Abgrenzung:** ein echter On-Platform-Vermittlungs-/Beratungs-Flow (Lead-Formular, Advice)
wäre §34i-erlaubnispflichtig → bewusst **NICHT** Teil dieses WP; separate, spätere
Business-/Rechtsentscheidung.

---

## Strang P — Produkt / USP (Delta F1–F6)

### WP-13 — KI-Gutachten-Analyse + Markt-Score (F1 + F2)
**Ziel:** strukturierte Felder (Zustand/Mängel/Lage/Besonderheiten) + Markt-Score aus dem besten
PDF — der stärkste Differenzierer gegen zvgscout.
**Scope:** wie Delta-Doc F1/F2: `analysis.post.ts` (Muster exakt wie `summary.post.ts` /
`translation.post.ts` aus WP-8: cache-first, inflight, rate-limit, JSON-Schema-Call), F2 als
dritter Block im selben Call; Cache Postgres (analog `content_translations`); UI-Block mit
**Disclaimer** „KI-Schätzung, keine Beratung". Nutzt vorhandene PDF-Pipeline (`pickBestPdf`).
**Abhängigkeit:** keine (LLM/PDF-Infra da). **Akzeptanz:** DE-Objekt mit Gutachten → valides
strukturiertes JSON + plausibler Score + Begründung; zweiter Aufruf trifft Cache; Objekt ohne
PDF → sauberer Leerzustand.

### WP-14 — Karten-Layer: POI + Messwerkzeuge (F4 + F5)
**Ziel:** Infrastruktur-Umfeld (Schule/ÖPNV/Einkauf) + Distanz/Flächen-Messen auf der Detailkarte.
**Scope:** F5 zuerst (trivial, `leaflet-measure`/`-draw`, clientseitig); F4: `pois.get.ts`
(Overpass, gecacht via `json-cache`), Marker-Layer + Legende in `AuctionDetailMap.client.vue`.
**Abhängigkeit:** keine. **Akzeptanz:** städtisches Objekt zeigt plausible POIs mit Distanz
(zweiter Aufruf = Cache-Treffer); Messen liefert m/km bzw. m²/ha.

### WP-15 — Flurstück-Grenzen (F3, WMS)
**Ziel:** amtliche Flurstückgrenzen als Toggle-Layer auf der Detailkarte.
**Scope:** `L.tileLayer.wms` in `AuctionDetailMap.client.vue` + `lib/flurstueck-wms.ts`
(Bundesland→Dienst/Layer/Params). **Inkrementell pro Bundesland**; Footgun (Memory
`map-tile-alignment-fr-fix`): Params-Case + EPSG:25832 vs 3857 pro Dienst verifizieren.
**Abhängigkeit:** keine. **Akzeptanz:** 2–3 Bundesländer deckungsgleich mit der Basemap;
Länder ohne Dienst → Toggle ausgeblendet, kein Fehler. **Session-Hinweis:** kann über mehrere
Sessions pro Bundesland-Gruppe wachsen.

### WP-16 — Nutzer-Statistik-Seite (F6)
**Ziel:** „aktivste Landkreise", Preis-/Objektart-Verteilungen, Trends für Endnutzer.
**Scope:** `stats.get.ts` + `pages/statistik.vue`. **Historie ist da** (`auction_observations`,
dongarra Phase 3) → direkt die reichere Variante (Trends über Zeit), nicht nur Snapshot.
**Abhängigkeit:** keine (Historie gemergt). **Akzeptanz:** Kennzahlen stimmen mit
stichprobenhaft gezählten Werten; Trend nutzt `auction_observations`.

---

## Strang D — Daten & Archiv

### WP-17 — hanmark.de-Crawler + Cross-Referencing (F8)
**Ziel:** Zweitquelle + echtes Anreichern desselben Objekts (statt nur Dedup).
**Scope:** **erst Quellen-Spike** (crawlbar? robots/Rechtslage? — Muster wie SK/PT-Bewertung),
dann Crawler + Cross-Ref über das vorhandene `(authority, caseNumber)`-Matching in `registry.ts`.
**Abhängigkeit:** keine, aber **gated auf Spike-Ergebnis** (bei negativem Spike zurückstellen).
**Akzeptanz:** Objekt aus zwei Quellen zeigt zusammengeführte Zusatzdaten ohne Listen-Duplikat.

### WP-18 — Archiv-Reprocessing-Tool
**Ziel:** F1/F2 bzw. Extraktion mit besserer Logik aus dem G1-Archiv neu fahren — **ohne
Re-Crawl** (der Payoff von Schicht 2/2b).
**Scope:** Tool, das über `raw_captures` die Blobs eines Objekts findet, Bytes aus S3 statt
Upstream lädt, Extraktion/Analyse neu fährt. Reihenfolge `(platform, externalId) → raw_captures
→ content_hash → raw_blobs → S3`.
**Abhängigkeit:** WP-13 (F1/F2) + G1-Archiv (da). **Akzeptanz:** ein Reprocess-Lauf ersetzt
Analyse-Ergebnisse aus Archiv-Bytes, kein einziger Upstream-Fetch (per Log/Netz prüfbar).

---

## Bewusst zurückgestellt (kein aktives WP — Trigger dokumentiert)

- **G3-B — Nutzer-zahlt „ZVG-Check" (Festpreis-Produkt):** zweiseitiger Zahlungsfluss +
  produktisiertes Anwalts-Angebot. **Trigger:** nach WP-9/10 (Billing steht) **und**
  Produktvalidierung, dass Nutzer für einen Festpreis-Check zahlen. v2-Experiment.
- **G2 — GraphQL-API:** die JSON-Daten-API (dongarra Phase 5) deckt den Bedarf. **Trigger:**
  erst wenn ein konkreter Kunde GraphQL verlangt → dann via PostGraphile/Hasura aus dem Schema.
  Nicht spekulativ bauen.
- **Archiv Schicht 3 (jeder HTTP-Response inkl. Listen-HTML):** **Trigger:** konkreter
  Voll-Provenienz-/Rechtsbedarf.
- **F7 Google Maps + StreetView (Premium-Layer):** hängt an WP-10 (Premium-Gating);
  danach niedrige Prio, zusätzlicher Tile-Layer + Embed hinter `isPremium`.

## Empfohlene Reihenfolge

Zwei legitime Einstiege, je nach Geschäftslage:
- **Umsatz zuerst:** WP-9 → WP-10 (bzw. WP-11, je nachdem welche Säule zuerst zahlt).
- **USP/Akquise zuerst:** WP-13 (KI-Analyse) — zieht Nutzer, bevor man sie monetarisiert.

Pragmatisch parallel (verschiedene Stränge, konfliktarm): **WP-9 (Billing)** *und* **WP-13
(KI-Analyse)** gleichzeitig — Server-Billing vs. LLM-Analyse-Endpoint berühren getrennte
Bereiche. WP-14/15/16 (Karten/Statistik, Frontend) danach oder parallel dazu.
