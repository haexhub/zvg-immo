// Deterministic size/number parsing for the rules extraction pass. Conservative
// by design: it only matches clearly labeled values and bails to null otherwise,
// leaving ambiguous text to the LLM fallback. Mis-extraction is worse than a
// miss here, so the patterns forbid digits between a label and its value.

/** Parse a localized number. Handles German ("1.234,56", "1.500") and
 *  English/Anglo grouping ("1,234.56", "1,234"): with both separators present
 *  the rightmost one is the decimal mark; a lone comma is a thousands
 *  separator only for exact 3-digit groups, else a decimal mark. */
export function parseLocaleNumber(raw: string): number | null {
  // Space-grouped thousands ("1 331", incl. NBSP) — Swedish/French style.
  let s = raw.trim().replace(/[\s ]+/g, '')
  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')
  if (lastDot !== -1 && lastComma !== -1) {
    const thousands = lastDot > lastComma ? ',' : '.'
    s = s.split(thousands).join('')
    if (thousands === '.') s = s.replace(',', '.')
  } else if (lastComma !== -1) {
    s = /^\d{1,3}(?:,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.')
  } else if (lastDot !== -1 && !/^\d+\.\d{1,2}$/.test(s)) {
    // A single dot with a 1–2 digit fraction ("2.5") is a decimal point;
    // groups of 3 digits ("1.500", "1.234.567") are thousands separators.
    s = s.replace(/\./g, '')
  }
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : null
}

// A number immediately followed by an area unit. The negative lookahead stops
// "m2" matching "m2x", "mq" matching "mqx" and "ha" matching "haus".
// "mq" is the common Italian notation, "τ.μ." the Greek one.
// First alternative: space-grouped thousands ("1 331", "12 500,50" — Swedish/
// French style, incl. NBSP). The space is only allowed between 3-digit groups
// so enumerations ("Nr. 5, 175 m²") can't be glued into one number.
const NUM = '(?:\\d{1,3}(?:[ \\u00a0]\\d{3})+(?:,\\d+)?|\\d(?:[\\d.,]*\\d)?)'
const AREA_UNIT = 'm²|m2|qm|kvm|mq|ha|τ\\.μ\\.'
const AREA_TOKEN = `${NUM}\\s*(?:${AREA_UNIT})`
const AREA_RE = new RegExp(`(${NUM})\\s*(${AREA_UNIT})(?![a-z\\d])`, 'i')

/** "140 m²" → 140, "2,5 ha" → 25000, "214.000,00 Euro" → null. */
export function parseAreaValue(text: string): number | null {
  const m = text.match(AREA_RE)
  if (!m || !m[1] || !m[2]) return null
  const value = parseLocaleNumber(m[1])
  if (value == null) return null
  return m[2].toLowerCase() === 'ha' ? value * 10000 : value
}

/** Find the area value that directly follows one of the given labels.
 *  Takes a precompiled regex — these run once per auction on the enrich hot
 *  path, so the big label alternations are compiled once at module load. */
function findLabeledArea(text: string, re: RegExp): number | null {
  const m = text.match(re)
  return m && m[1] ? parseAreaValue(m[1]) : null
}

// The lookahead stops the unit matching inside a word ("Grundstück mit
// 1 Haus" must not read "1 Ha" as one hectare).
function compileLabeledAreaRe(labelAlternation: string): RegExp {
  return new RegExp(`(?:${labelAlternation})\\D{0,14}?(${AREA_TOKEN})(?![a-zäöü\\d])`, 'i')
}

const LIVING_LABELS =
  'wohnfläche|wohnnutzfläche|wohn-?/?nutzfläche|wohnfl\\.?|wfl\\.?' +
  // Czech
  '|podlahová plocha|užitná plocha|obytná plocha|plocha bytu' +
  // Polish
  // \S* covers the declined forms (powierzchnię użytkową, powierzchni użytkowej)
  // — \w misses Polish diacritics.
  '|powierzchni\\S* użytkow\\S*|powierzchni\\S* mieszkaln\\S*' +
  // Bosnian/Croatian/Serbian
  '|stambena površina|korisna površina|površina stana' +
  // Hungarian
  '|lakóterület|alapterület|hasznos alapterület' +
  // Lithuanian
  '|gyvenamasis plotas|naudingasis plotas' +
  // Swedish
  '|boarea|bostadsyta|boyta|lägenhetsyta|storlek' +
  // Spanish
  '|superficie construida|superficie útil|superficie habitable' +
  // Italian
  '|superficie commerciale|superficie utile|superficie catastale' +
  // French
  '|surface habitable|surface utile' +
  // Dutch (Belgium)
  '|bewoonbare oppervlakte|woonoppervlakte' +
  // Danish
  '|boligareal|beboelsesareal' +
  // Finnish
  '|asuinpinta-ala|huoneistoala|asuntoala' +
  // Icelandic
  '|flatarmál íbúðar|stærð íbúðar' +
  // Latvian
  '|dzīvojamā platība' +
  // Estonian
  '|eluruumi pind|elamispind' +
  // Portuguese
  '|área bruta privativa|área útil|área bruta|área de construção' +
  // Greek
  '|επιφάνεια κατοικίας|εμβαδόν διαμερίσματος'

const LAND_LABELS =
  'grundstücksgröße|grundstücksfläche|grundstück|bodenfläche|grundfläche|flurstück' +
  // Czech
  '|výměra pozemku|plocha pozemku|výměra' +
  // Polish
  '|powierzchnia działki|powierzchnia gruntu|działka' +
  // Bosnian/Croatian/Serbian
  '|površina parcele|površina zemljišta' +
  // Hungarian
  '|telekterület|telek nagysága' +
  // Lithuanian
  '|sklypo plotas|žemės plotas' +
  // Swedish
  '|tomtmark|tomtyta|tomtareal|fastighetens areal|tomtstorlek' +
  // Spanish
  '|superficie del solar|superficie de la parcela|extensión superficial|superficie de la finca' +
  // Italian
  '|superficie del terreno|superficie fondiaria' +
  // French
  '|surface du terrain|surface de la parcelle|contenance cadastrale' +
  // Dutch (Belgium)
  '|perceelsoppervlakte|grondoppervlakte|kadastrale oppervlakte' +
  // Danish
  '|grundareal|grundstørrelse' +
  // Finnish
  '|tontin pinta-ala|maapinta-ala|kiinteistön pinta-ala' +
  // Icelandic
  '|lóðarstærð|flatarmál lóðar' +
  // Latvian
  '|zemes gabala platība' +
  // Estonian
  '|maatüki pind|krundi pind' +
  // Swedish (kronofogden labels the plot description "Tomtbeskrivning: ca 1 331 kvm tomtmark")
  '|tomtbeskrivning' +
  // Portuguese
  '|área do terreno|área total do terreno' +
  // Greek
  '|εμβαδόν οικοπέδου|επιφάνεια οικοπέδου'

const LIVING_AREA_RE = compileLabeledAreaRe(LIVING_LABELS)
const LAND_AREA_RE = compileLabeledAreaRe(LAND_LABELS)

export function findLivingAreaSqm(text: string): number | null {
  return findLabeledArea(text, LIVING_AREA_RE)
}

export function findLandAreaSqm(text: string): number | null {
  return findLabeledArea(text, LAND_AREA_RE)
}

// The fallback patterns ("label then number") must not fire on compounds
// ("Wohnzimmer", "2 Schlafzimmer") — hence the negative lookbehind — and the
// gap between label and number must be letter-free so prose like
// "Wohneinheit Nr. 5" isn't read as a count. The number-first patterns are
// safe: NUM directly precedes the label, so a compound can't match.

// Room-count words across the crawled languages. Number-first only ("6 rum",
// "3 pokoje", "3-toaline") except where the label-first form is idiomatic
// (German "Zimmer: 3", Italian "vani 4,5"). Word endings are matched loosely
// where declension varies (pokoje/pokoi/pokojů, kambariai/kambarių).
const ROOM_WORDS =
  'zimmer|zi\\.' +
  '|rum(?![a-zåäö])' + // Swedish
  '|vani|locali' + // Italian
  '|pièces?' + // French
  '|habitaciones' + // Spanish
  '|pok[oó]j\\w*|pokoj\\w*|pokoi|pokoje' + // Polish/Czech
  '|szob[aá]s?' + // Hungarian
  '|kambar\\w*' + // Lithuanian
  '|istab\\w*' + // Latvian
  '|toaline|tuba' + // Estonian ("3-toaline", "3 tuba")
  '|huonetta' + // Finnish
  '|værelser' + // Danish
  '|δωμάτι\\w*' // Greek

const ROOMS_NUM_FIRST_RE = new RegExp(`(${NUM})[\\s-]*(?:${ROOM_WORDS})`, 'i')
const ROOMS_LABEL_FIRST_RE = new RegExp(
  `(?<![a-zäöüß])(?:zimmer|vani)[^a-zäöüß\\d]{0,6}?(${NUM})`,
  'i',
)

export function findRooms(text: string): number | null {
  let m = text.match(ROOMS_NUM_FIRST_RE)
  if (m && m[1]) return parseLocaleNumber(m[1])
  m = text.match(ROOMS_LABEL_FIRST_RE)
  if (m && m[1]) return parseLocaleNumber(m[1])
  return null
}

export function findUnits(text: string): number | null {
  let m = text.match(/(\d+)\s*wohneinheiten?/i)
  if (m && m[1]) return parseInt(m[1], 10)
  m = text.match(/(?<![a-zäöüß])wohneinheiten?[^a-zäöüß\d]{0,6}?(\d+)/i)
  if (m && m[1]) return parseInt(m[1], 10)
  return null
}
