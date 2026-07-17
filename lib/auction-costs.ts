// Erwerbsnebenkosten-Rechner für deutsche Zwangsversteigerungen (ZVG).
// Reine Funktion, kein Server-/DB-Zugriff — siehe Plan "Nebenkosten-/Kostenrechner (Phase 6)".
//
// Scope v1: nur Deutschland. Grunderwerbsteuer, Gerichts- und Grundbuchkosten sind
// bundeslandspezifisches/deutsches Recht und für die übrigen Plattformen in
// server/crawlers/registry.ts nicht anwendbar.

/** Die 16 deutschen Bundesländer, exakt wie sie als `Auction.region` bei den
 *  DE-Crawlern (zvg-portal, mv-zvgcom) auftauchen — siehe
 *  server/crawlers/zvg-portal/constants.ts (DE_REGION_NAMES) und
 *  server/crawlers/mv-zvgcom/list.ts. */
export const BUNDESLAENDER = [
  'Baden-Württemberg',
  'Bayern',
  'Berlin',
  'Brandenburg',
  'Bremen',
  'Hamburg',
  'Hessen',
  'Mecklenburg-Vorpommern',
  'Niedersachsen',
  'Nordrhein-Westfalen',
  'Rheinland-Pfalz',
  'Saarland',
  'Sachsen',
  'Sachsen-Anhalt',
  'Schleswig-Holstein',
  'Thüringen',
] as const

export type Bundesland = (typeof BUNDESLAENDER)[number]

/** Grunderwerbsteuersätze je Bundesland, Stand 2026 (Anteil, nicht Prozent).
 *  Verifiziert per Web-Recherche (finanz-tools.de, rechenbar.de — beide
 *  stimmen überein), Stand der letzten Änderungen:
 *  - Sachsen: 5,5 % seit 01.01.2023 (vorher 3,5 %)
 *  - Hamburg: 5,5 % seit 01.01.2023 (vorher 4,5 %)
 *  - Thüringen: 5,0 % seit 01.01.2024 (vorher 6,5 %)
 *  - Bremen: 5,5 % seit 01.07.2025 (vorher 5,0 %)
 *  Änderungen sind selten, aber nicht ausgeschlossen — bei Zweifel gegen die
 *  aktuellen Landesgesetze prüfen. */
export const GRUNDERWERBSTEUER_SATZ: Record<Bundesland, number> = {
  'Baden-Württemberg': 0.05,
  Bayern: 0.035,
  Berlin: 0.06,
  Brandenburg: 0.065,
  Bremen: 0.055,
  Hamburg: 0.055,
  Hessen: 0.06,
  'Mecklenburg-Vorpommern': 0.06,
  Niedersachsen: 0.05,
  'Nordrhein-Westfalen': 0.065,
  'Rheinland-Pfalz': 0.05,
  Saarland: 0.065,
  Sachsen: 0.055,
  'Sachsen-Anhalt': 0.05,
  'Schleswig-Holstein': 0.065,
  Thüringen: 0.05,
}

/** Zinssatz nach § 49 ZVG auf das Bargebot ab Zuschlag bis zur tatsächlichen Zahlung. */
const ZINSSATZ_PA = 0.04

/**
 * Gebührentabelle für eine "1,0 Gebühr" nach Anlage 2 GKG / Anlage 2 Tabelle A
 * GNotKG. Beide Tabellen sind seit der Kostenrechtsreform wertidentisch —
 * verifiziert gegen dejure.org (Anlage 2 GKG) und gesetze-im-internet.de
 * (Anlage 2 GNotKG), Stand der Tabelle: 01.06.2025.
 *
 * Deckt Geschäftswerte bis 500.000 € exakt ab (die weit überwiegende Mehrheit
 * der ZVG-Bargebote für Wohnimmobilien). Für höhere Werte siehe
 * `volleGebuehr()` unten — dort wird linear extrapoliert, das ist NICHT
 * gegen den Gesetzestext verifiziert.
 */
const GEBUEHRENTABELLE: ReadonlyArray<{ bis: number; gebuehr: number }> = [
  { bis: 500, gebuehr: 40.0 },
  { bis: 1_000, gebuehr: 61.0 },
  { bis: 1_500, gebuehr: 82.0 },
  { bis: 2_000, gebuehr: 103.0 },
  { bis: 3_000, gebuehr: 125.5 },
  { bis: 4_000, gebuehr: 148.0 },
  { bis: 5_000, gebuehr: 170.5 },
  { bis: 6_000, gebuehr: 193.0 },
  { bis: 7_000, gebuehr: 215.5 },
  { bis: 8_000, gebuehr: 238.0 },
  { bis: 9_000, gebuehr: 260.5 },
  { bis: 10_000, gebuehr: 283.0 },
  { bis: 13_000, gebuehr: 313.5 },
  { bis: 16_000, gebuehr: 344.0 },
  { bis: 19_000, gebuehr: 374.5 },
  { bis: 22_000, gebuehr: 405.0 },
  { bis: 25_000, gebuehr: 435.5 },
  { bis: 30_000, gebuehr: 476.0 },
  { bis: 35_000, gebuehr: 516.5 },
  { bis: 40_000, gebuehr: 557.0 },
  { bis: 45_000, gebuehr: 597.5 },
  { bis: 50_000, gebuehr: 638.0 },
  { bis: 65_000, gebuehr: 778.0 },
  { bis: 80_000, gebuehr: 918.0 },
  { bis: 95_000, gebuehr: 1058.0 },
  { bis: 110_000, gebuehr: 1198.0 },
  { bis: 125_000, gebuehr: 1338.0 },
  { bis: 140_000, gebuehr: 1478.0 },
  { bis: 155_000, gebuehr: 1618.0 },
  { bis: 170_000, gebuehr: 1758.0 },
  { bis: 185_000, gebuehr: 1898.0 },
  { bis: 200_000, gebuehr: 2038.0 },
  { bis: 230_000, gebuehr: 2248.0 },
  { bis: 260_000, gebuehr: 2458.0 },
  { bis: 290_000, gebuehr: 2668.0 },
  { bis: 320_000, gebuehr: 2878.0 },
  { bis: 350_000, gebuehr: 3088.0 },
  { bis: 380_000, gebuehr: 3298.0 },
  { bis: 410_000, gebuehr: 3508.0 },
  { bis: 440_000, gebuehr: 3718.0 },
  { bis: 470_000, gebuehr: 3928.0 },
  { bis: 500_000, gebuehr: 4138.0 },
]

const MAX_TABELLE_WERT = 500_000
const MAX_TABELLE_GEBUEHR = 4138.0
// Ab 500.000 € ist die Tabelle hier nicht mehr hinterlegt (Werte darüber sind
// bei ZVG-Wohnimmobilien selten). Als Näherung wird die Steigung des letzten
// bekannten Segments (200.000 € → 500.000 €, 30.000-€-Schritte à 210 €)
// fortgeschrieben. PLATZHALTER — vor Produktiveinsatz für hochpreisige Fälle
// gegen die aktuelle Anlage 2 GKG/GNotKG verifizieren.
const EXTRAPOLATION_SCHRITT_WERT = 30_000
const EXTRAPOLATION_SCHRITT_GEBUEHR = 210.0

/** "1,0 Gebühr" für einen gegebenen Geschäftswert nach der GKG/GNotKG-Tabelle. */
export function volleGebuehr(geschaeftswert: number): number {
  const wert = Math.max(0, geschaeftswert)
  if (wert > MAX_TABELLE_WERT) {
    const mehrwert = wert - MAX_TABELLE_WERT
    const schritte = Math.ceil(mehrwert / EXTRAPOLATION_SCHRITT_WERT)
    return round2(MAX_TABELLE_GEBUEHR + schritte * EXTRAPOLATION_SCHRITT_GEBUEHR)
  }
  const treffer = GEBUEHRENTABELLE.find((row) => wert <= row.bis)
  return treffer?.gebuehr ?? MAX_TABELLE_GEBUEHR
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** Bundesland aus `Auction.region` ableiten (DE-Crawler setzen dort exakt den
 *  Bundesland-Namen ein). Gibt `null` zurück, wenn keine Zuordnung möglich ist —
 *  die UI soll dann eine manuelle Dropdown-Auswahl anbieten. */
export function bundeslandFromRegion(region: string | null | undefined): Bundesland | null {
  if (!region) return null
  return (BUNDESLAENDER as readonly string[]).includes(region) ? (region as Bundesland) : null
}

export interface AuctionCostInput {
  /** Bargebot in EUR (das tatsächliche Meistgebot, editierbar vorbefüllt mit dem Verkehrswert). */
  bargebot: number
  bundesland: Bundesland
  /** Geschätzte Anzahl Tage vom Zuschlag bis zur tatsächlichen Zahlung (§ 49 ZVG). */
  tageBisZahlung: number
}

export interface AuctionCostItem {
  label: string
  amountEur: number
  note?: string
}

export interface AuctionCostResult {
  bundesland: Bundesland
  grunderwerbsteuerSatz: number
  grunderwerbsteuerEur: number
  gerichtskostenZuschlagEur: number
  grundbuchkostenEur: number
  zinsenEur: number
  maklerprovisionEur: number
  notarkostenEur: number
  /** Aufschlüsselung in Anzeige-Reihenfolge, inkl. der 0-€-Posten mit Hinweistext. */
  items: AuctionCostItem[]
  /** Summe aller Posten in `items` (== Summe der o.g. Einzelwerte). */
  nebenkostenGesamtEur: number
  /** Bargebot + nebenkostenGesamtEur. */
  gesamtkostenEur: number
}

/**
 * Berechnet die Erwerbsnebenkosten für den Zuschlag einer deutschen
 * Zwangsversteigerung. Reine Funktion ohne Seiteneffekte.
 *
 * Posten:
 * - Grunderwerbsteuer: Bundesland-Satz × Bargebot.
 * - Gerichtskosten für den Zuschlagsbeschluss: 0,5 Gebühr nach GKG-Kostenverzeichnis
 *   Nr. 2214 ("Erteilung des Zuschlags"), Geschäftswert = Bargebot.
 * - Grundbuchkosten für die Eigentumsumschreibung: 1,0 Gebühr nach GNotKG-Kostenverzeichnis
 *   Nr. 14110 ("Eintragung eines Eigentümers"), Geschäftswert = Bargebot.
 * - Zinsen ab Zuschlag: 4 % p.a. auf das Bargebot, taggenau (§ 49 ZVG).
 * - Maklerprovision und Notarkosten: immer 0 € — bei einer ZVG entfällt der
 *   Kaufvertrag (der Zuschlagsbeschluss ersetzt ihn), damit auch die dafür
 *   sonst übliche Notarbeurkundung und ein Makler ist bei einer
 *   Gerichtsversteigerung nicht zwingend beteiligt.
 */
export function calculateAuctionCosts(input: AuctionCostInput): AuctionCostResult {
  const bargebot = Math.max(0, input.bargebot)
  const tage = Math.max(0, input.tageBisZahlung)
  const satz = GRUNDERWERBSTEUER_SATZ[input.bundesland]

  const grunderwerbsteuerEur = round2(bargebot * satz)
  const gerichtskostenZuschlagEur = round2(0.5 * volleGebuehr(bargebot))
  const grundbuchkostenEur = round2(1.0 * volleGebuehr(bargebot))
  const zinsenEur = round2((bargebot * ZINSSATZ_PA * tage) / 365)
  const maklerprovisionEur = 0
  const notarkostenEur = 0

  const items: AuctionCostItem[] = [
    {
      label: 'Grunderwerbsteuer',
      amountEur: grunderwerbsteuerEur,
      note: `${(satz * 100).toLocaleString('de-DE')} % (${input.bundesland})`,
    },
    {
      label: 'Gerichtskosten (Zuschlagsbeschluss)',
      amountEur: gerichtskostenZuschlagEur,
    },
    {
      label: 'Grundbuchkosten (Eigentumsumschreibung)',
      amountEur: grundbuchkostenEur,
    },
    {
      label: 'Zinsen ab Zuschlag (§ 49 ZVG, 4 % p.a.)',
      amountEur: zinsenEur,
      note: `${tage} Tage`,
    },
    {
      label: 'Maklerprovision',
      amountEur: maklerprovisionEur,
      note: 'entfällt bei ZVG — kein Kaufvertrag nötig',
    },
    {
      label: 'Notarkosten',
      amountEur: notarkostenEur,
      note: 'entfällt bei ZVG — kein Kaufvertrag nötig',
    },
  ]

  const nebenkostenGesamtEur = round2(items.reduce((sum, i) => sum + i.amountEur, 0))
  const gesamtkostenEur = round2(bargebot + nebenkostenGesamtEur)

  return {
    bundesland: input.bundesland,
    grunderwerbsteuerSatz: satz,
    grunderwerbsteuerEur,
    gerichtskostenZuschlagEur,
    grundbuchkostenEur,
    zinsenEur,
    maklerprovisionEur,
    notarkostenEur,
    items,
    nebenkostenGesamtEur,
    gesamtkostenEur,
  }
}
