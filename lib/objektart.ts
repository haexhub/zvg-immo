export interface ObjektKategorie {
  id: string
  label: string
}

/** Canonical property-type ids the rules/LLM extractor may emit. Mirrors the
 *  RULES ids below plus 'sonstiges'. 'unbekannt' is represented as null. */
export type PropertyType =
  | 'mehrfamilienhaus'
  | 'zweifamilienhaus'
  | 'wohn-geschaefts'
  | 'doppelhaushaelfte'
  | 'reihenhaus'
  | 'einfamilienhaus'
  | 'eigentumswohnung'
  | 'gewerbe'
  | 'land-forst'
  | 'unbebaut'
  | 'garage-stellplatz'
  | 'sonstiges'

/** Runtime list of the PropertyType union — for LLM schema enums and validation
 *  (TypeScript can't enumerate a type at runtime). Keep in sync with the union. */
export const PROPERTY_TYPES: readonly PropertyType[] = [
  'mehrfamilienhaus',
  'zweifamilienhaus',
  'wohn-geschaefts',
  'doppelhaushaelfte',
  'reihenhaus',
  'einfamilienhaus',
  'eigentumswohnung',
  'gewerbe',
  'land-forst',
  'unbebaut',
  'garage-stellplatz',
  'sonstiges',
]

interface KategorieRule extends ObjektKategorie {
  test: RegExp
}

// Priority order: the first rule whose test matches the raw `objekt` string
// wins. Compound entries like "Einfamilienhaus, Garage" classify as
// Einfamilienhaus because that rule fires before the standalone-garage rule.
// More specific / dominant types come first, accessory types last.
//
// Non-German terms cover the other crawled countries' listing languages (ES,
// IT, FR, NL for Belgium, CZ, PL, HU, LT, LV, EE, BA/HR/SR, SE, FI, DK, IS, GR).
// Kept conservative like the sizes.ts labels: only added terms unambiguous
// enough to trust without cross-checking context — a miss falls through to
// the LLM fallback, a wrong match doesn't.
//
// Greek terms skip the \b word-boundary convention used elsewhere: JS regexes
// without the /u flag treat \w as ASCII-only, so \b never matches around
// Greek letters (both sides read as "non-word", meaning no boundary at all).
const RULES: KategorieRule[] = [
  {
    id: 'mehrfamilienhaus',
    label: 'Mehrfamilienhaus',
    test: /mehrfamilienhaus|dreifamilienhaus|edificio (?:plurifamiliar|de viviendas)|vivienda plurifamiliar|edificio plurifamiliare|immeuble (?:collectif|de rapport|d'habitation)|meergezinswoning|appartementsgebouw|bytový dům|budynek wielorodzinny|kamienica|daugiabutis|daudzdzīvokļu māja|korterelamu|flerbostadshus|kerrostalo|etageejendom|flerfamiliehus|fjölbýlishús|πολυκατοικία/i,
  },
  { id: 'zweifamilienhaus', label: 'Zweifamilienhaus', test: /zweifamilienhaus|casa bifamiliare|maison bifamiliale/i },
  // Matches "Wohn- und Geschäftshaus", "Wohn-/Geschäftshaus", "Wohn/Geschäftshaus".
  {
    id: 'wohn-geschaefts',
    label: 'Wohn-/Geschäftshaus',
    test: /wohn-?\s*(?:und\s+|\/\s*)?geschäftshaus|stambeno-poslovni objekat|κτίριο μικτής χρήσης/i,
  },
  {
    id: 'doppelhaushaelfte',
    label: 'Doppelhaushälfte',
    test: /doppelhaushälfte|chalet pareado|vivienda pareada|maison jumelée|halfvrijstaande woning|dvojdomek|bliźniak|dobbelthus|parhus|paritalo/i,
  },
  {
    id: 'reihenhaus',
    label: 'Reihenhaus',
    test: /reihenhaus|(?:vivienda|casa) adosada|casa a schiera|maison (?:mitoyenne|en bande)|rijwoning|rijtjeshuis|řadový dům|dom szeregowy|sorház|rindas māja|ridaelamu|radhus|rivitalo|rækkehus|raðhús/i,
  },
  {
    id: 'einfamilienhaus',
    label: 'Einfamilienhaus',
    test: /einfamilienhaus|vivienda unifamiliar|casa unifamiliar|casa unifamiliare|villetta|maison individuelle|eengezinswoning|rodinný dům|dom jednorodzinny|családi ház|vienbutis namas|savrupmāja|eramu|villa|enfamiljshus|omakotitalo|enfamiliehus|parcelhus|einbýlishús|porodična kuća|stanovanjska hiša|μονοκατοικία/i,
  },
  {
    id: 'eigentumswohnung',
    label: 'Eigentumswohnung',
    test: /eigentumswohnung|sonstiges teileigentum|wohnung und anteil|\bpiso\b|apartamento|appartamento|appartement|mieszkanie|\blakás\b|\bbutas\b|dzīvoklis|\bkorter\b|lägenhet|bostadsrätt|asunto-osake|huoneisto|ejerlejlighed|lejlighed|\bíbúð\b|\bstan\b|stanovanje|διαμέρισμα/i,
  },
  {
    id: 'gewerbe',
    label: 'Gewerbe',
    test: /gewerb|local comercial|nave industrial|immobile commerciale|capannone industriale|local commercial|local professionnel|bedrijfspand|kantoorruimte|komerční prostor|lokal użytkowy|lokal usługowy|üzlethelyiség|komercinės paskirties|komercplatības|äripind|kommersiell fastighet|affärslokal|liikehuoneisto|toimitila|erhvervsejendom|atvinnuhúsnæði|poslovni prostor|κατάστημα|επαγγελματικ|γραφείο/i,
  },
  {
    id: 'land-forst',
    label: 'Land-/Forstwirtschaft',
    test: /forstwirtschaft|landwirt|ackerland|terreno rústico|finca rústica|terreno agricolo|fondo rustico|terrain agricole|terres agricoles|landbouwgrond|zemědělská půda|grunt rolny|ziemia rolna|mezőgazdasági terület|žemės ūkio paskirties|lauksaimniecības zeme|põllumajandusmaa|jordbruksmark|skogsmark|maatalousmaa|metsämaa|landbrugsjord|poljoprivredno zemljište|αγροτεμάχιο|δασική έκταση/i,
  },
  {
    id: 'unbebaut',
    label: 'Unbebautes Grundstück',
    test: /unbebautes grundstück|baugrundstück|\bsolar\b|terreno edificable|terreno edificabile|area edificabile|terrain à bâtir|terrain constructible|bouwgrond|stavební pozemek|działka budowlana|építési telek|byggklar tomt|obebyggd tomt|byggegrund|nezazidano stavbno zemljišče|οικόπεδο/i,
  },
  {
    id: 'garage-stellplatz',
    label: 'Garage / Stellplatz',
    // Substring match on purpose: compounds and plurals ("Tiefgaragenstellplatz",
    // "Doppelgarage", "Garagen", "Stellplätze") must classify as garage too.
    test: /garage|stellpl(?:atz|ätze)|garaje|plaza de aparcamiento|posto auto|place de parking|parkeerplaats|garáž|parkovací stání|garaż|miejsce postojowe|garázs|garažas|garāža|garaaž|parkeringsplats|autotalli|autopaikka|parkeringsplads|bílskúr|θέση στάθμευσης|γκαράζ/i,
  },
]

const SONSTIGES: ObjektKategorie = { id: 'sonstiges', label: 'Sonstiges' }
const UNBEKANNT: ObjektKategorie = { id: 'unbekannt', label: 'Unbekannt' }

export function classifyObjekt(objekt: string | null | undefined): ObjektKategorie {
  if (!objekt) return UNBEKANNT
  for (const r of RULES) {
    if (r.test.test(objekt)) return { id: r.id, label: r.label }
  }
  return SONSTIGES
}

/** All categories classifyObjekt can return, in display order. */
export const ALL_KATEGORIEN: readonly ObjektKategorie[] = [
  ...RULES.map((r) => ({ id: r.id, label: r.label })),
  SONSTIGES,
  UNBEKANNT,
] as const
