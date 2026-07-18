export interface PropertyTypeCategory {
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

interface PropertyTypeRule extends PropertyTypeCategory {
  test: RegExp
}

// Priority order: the first rule whose test matches the raw `title` string
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
// They are also spelled lowercase WITHOUT tonos ("διαμερισμα"): Greek portals
// often write ALL-CAPS, which by convention drops the accents ("ΔΙΑΜΕΡΙΣΜΑ"),
// and /i can't bridge that (ί and Ι differ even case-folded) — foldGreek
// below normalizes the input to the same unaccented lowercase form.
const RULES: PropertyTypeRule[] = [
  {
    id: 'mehrfamilienhaus',
    label: 'Mehrfamilienhaus',
    test: /mehrfamilienhaus|dreifamilienhaus|edificio (?:plurifamiliar|de viviendas)|vivienda plurifamiliar|edificio plurifamiliare|immeuble (?:collectif|de rapport|d'habitation)|meergezinswoning|appartementsgebouw|bytový dům|budynek wielorodzinny|kamienica|daugiabutis|daudzdzīvokļu māja|korterelamu|flerbostadshus|kerrostalo|etageejendom|flerfamiliehus|fjölbýlishús|πολυκατοικια/i,
  },
  { id: 'zweifamilienhaus', label: 'Zweifamilienhaus', test: /zweifamilienhaus|casa bifamiliare|maison bifamiliale/i },
  // Matches "Wohn- und Geschäftshaus", "Wohn-/Geschäftshaus", "Wohn/Geschäftshaus".
  {
    id: 'wohn-geschaefts',
    label: 'Wohn-/Geschäftshaus',
    test: /wohn-?\s*(?:und\s+|\/\s*)?geschäftshaus|stambeno-poslovni objekat|κτιριο μικτης χρησης/i,
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
    test: /einfamilienhaus|vivienda unifamiliar|casa unifamiliar|casa unifamiliare|villetta|maison individuelle|eengezinswoning|rodinný dům|dom jednorodzinny|családi ház|vienbutis namas|savrupmāja|eramu|villa|enfamiljshus|omakotitalo|enfamiliehus|parcelhus|einbýlishús|porodična kuća|stanovanjska hiša|μονοκατοικια/i,
  },
  {
    id: 'eigentumswohnung',
    label: 'Eigentumswohnung',
    test: /eigentumswohnung|sonstiges teileigentum|wohnung und anteil|\bpiso\b|apartamento|appartamento|appartement|mieszkanie|\blakás\b|\bbutas\b|dzīvoklis|\bkorter\b|lägenhet|bostadsrätt|asunto-osake|huoneisto|ejerlejlighed|lejlighed|\bíbúð\b|\bstan\b|stanovanje|διαμερισμα/i,
  },
  {
    id: 'gewerbe',
    label: 'Gewerbe',
    test: /gewerb|local comercial|nave industrial|immobile commerciale|capannone industriale|local commercial|local professionnel|bedrijfspand|kantoorruimte|komerční prostor|lokal użytkowy|lokal usługowy|üzlethelyiség|komercinės paskirties|komercplatības|äripind|kommersiell fastighet|affärslokal|liikehuoneisto|toimitila|erhvervsejendom|atvinnuhúsnæði|poslovni prostor|καταστημα|επαγγελματικ|γραφειο/i,
  },
  {
    id: 'land-forst',
    label: 'Land-/Forstwirtschaft',
    test: /forstwirtschaft|landwirt|ackerland|terreno rústico|finca rústica|terreno agricolo|fondo rustico|terrain agricole|terres agricoles|landbouwgrond|zemědělská půda|grunt rolny|ziemia rolna|mezőgazdasági terület|žemės ūkio paskirties|lauksaimniecības zeme|põllumajandusmaa|jordbruksmark|skogsmark|maatalousmaa|metsämaa|landbrugsjord|poljoprivredno zemljište|αγροτεμαχιο|δασικη εκταση/i,
  },
  {
    id: 'unbebaut',
    label: 'Unbebautes Grundstück',
    test: /unbebautes grundstück|baugrundstück|\bsolar\b|terreno edificable|terreno edificabile|area edificabile|terrain à bâtir|terrain constructible|bouwgrond|stavební pozemek|działka budowlana|építési telek|byggklar tomt|obebyggd tomt|byggegrund|nezazidano stavbno zemljišče|οικοπεδο/i,
  },
  {
    id: 'garage-stellplatz',
    label: 'Garage / Stellplatz',
    // Substring match on purpose: compounds and plurals ("Tiefgaragenstellplatz",
    // "Doppelgarage", "Garagen", "Stellplätze") must classify as garage too.
    test: /garage|stellpl(?:atz|ätze)|garaje|plaza de aparcamiento|posto auto|place de parking|parkeerplaats|garáž|parkovací stání|garaż|miejsce postojowe|garázs|garažas|garāža|garaaž|parkeringsplats|autotalli|autopaikka|parkeringsplads|bílskúr|θεση σταθμευσης|γκαραζ/i,
  },
]

const SONSTIGES: PropertyTypeCategory = { id: 'sonstiges', label: 'Sonstiges' }
const UNBEKANNT: PropertyTypeCategory = { id: 'unbekannt', label: 'Unbekannt' }

const GREEK_TONOS: Record<string, string> = {
  ά: 'α', έ: 'ε', ή: 'η', ί: 'ι', ό: 'ο', ύ: 'υ', ώ: 'ω', ϊ: 'ι', ϋ: 'υ', ΐ: 'ι', ΰ: 'υ',
}

/** Lowercase Greek input and strip the tonos/dialytika so the unaccented rule
 *  spellings match both "Διαμέρισμα" and all-caps "ΔΙΑΜΕΡΙΣΜΑ" (uppercase
 *  Greek conventionally drops the accents). toLowerCase handles the final
 *  sigma (ΧΡΗΣΗΣ → χρησης), matching how the rules are written. Deliberately
 *  Greek-only — a blanket accent strip would break the Latin-diacritic terms
 *  (grundstück, řadový, savrupmāja, …). */
function foldGreek(s: string): string {
  if (!/[Ͱ-Ͽ]/.test(s)) return s
  return s.toLowerCase().replace(/[άέήίόύώϊϋΐΰ]/g, (c) => GREEK_TONOS[c]!)
}

export function classifyPropertyType(title: string | null | undefined): PropertyTypeCategory {
  if (!title) return UNBEKANNT
  const folded = foldGreek(title)
  for (const r of RULES) {
    if (r.test.test(folded)) return { id: r.id, label: r.label }
  }
  return SONSTIGES
}

/** All categories classifyPropertyType can return, in display order. */
export const ALL_PROPERTY_TYPE_CATEGORIES: readonly PropertyTypeCategory[] = [
  ...RULES.map((r) => ({ id: r.id, label: r.label })),
  SONSTIGES,
  UNBEKANNT,
] as const
