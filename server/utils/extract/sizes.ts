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
// "m2" matching "m2x", "mq" matching "mqx", "ha" matching "haus", and (Greek)
// "τμ" matching the start of "τμήμα" (a common word meaning "section/part" —
// Ͱ-Ͽ covers Greek letters, which plain [a-z] doesn't).
// "mq" is the common Italian notation; Greek listings write m² as "τ.μ."
// (τετραγωνικά μέτρα), sometimes without dots.
// First alternative: space-grouped thousands ("1 331", "12 500,50" — Swedish/
// French style, incl. NBSP). The space is only allowed between 3-digit groups
// so enumerations ("Nr. 5, 175 m²") can't be glued into one number.
const NUM = '(?:\\d{1,3}(?:[ \\u00a0]\\d{3})+(?:,\\d+)?|\\d(?:[\\d.,]*\\d)?)'
const AREA_UNIT = 'm²|m2|qm|kvm|mq|ha|τ\\.?μ\\.?'
const AREA_TOKEN = `${NUM}\\s*(?:${AREA_UNIT})`
const AREA_RE = new RegExp(`(${NUM})\\s*(${AREA_UNIT})(?![a-z\\d\\u0370-\\u03ff])`, 'i')

/** "140 m²" → 140, "2,5 ha" → 25000, "214.000,00 Euro" → null. */
export function parseAreaValue(text: string): number | null {
  const m = text.match(AREA_RE)
  if (!m || !m[1] || !m[2]) return null
  const isHa = m[2].toLowerCase() === 'ha'
  const raw = m[1].trim()
  // Hectare values are small comma-decimal figures in cadastral prose
  // ("2,575 ha" = 2.575 ha = 25.750 m²), never Anglo-grouped thousands —
  // parseLocaleNumber's lone-comma heuristic would read 2575 ha here, a
  // silent factor-1000 error. Treat the comma as a decimal mark for ha.
  const value =
    isHa && /^\d{1,3},\d{3}$/.test(raw)
      ? Number(raw.replace(',', '.'))
      : parseLocaleNumber(raw)
  if (value == null) return null
  return isHa ? value * 10000 : value
}

/** Find the area value that directly follows one of the given labels.
 *  Takes a precompiled regex — these run once per auction on the enrich hot
 *  path, so the big label alternations are compiled once at module load. */
function findLabeledArea(text: string, re: RegExp): number | null {
  const m = text.match(re)
  return m && m[1] ? parseAreaValue(m[1]) : null
}

// The lookahead stops the unit matching inside a word ("Grundstück mit
// 1 Haus" must not read "1 Ha" as one hectare, "2 τμήματα" not as 2 τ.μ.).
function compileLabeledAreaRe(labelAlternation: string): RegExp {
  return new RegExp(
    `(?:${labelAlternation})\\D{0,14}?(${AREA_TOKEN})(?![a-zäöü\\d\\u0370-\\u03ff])`,
    'i',
  )
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
  '|επιφάνεια κατοικίας|επιφάνεια διαμερίσματος|εμβαδόν κατοικίας|εμβαδόν διαμερίσματος'

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
  '|tomtmark|tomtyta|tomtareal|markareal(?:en)?|fastighetens areal|tomtstorlek' +
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
  '|έκταση οικοπέδου|επιφάνεια οικοπέδου|εμβαδόν οικοπέδου'

const LIVING_AREA_RE = compileLabeledAreaRe(LIVING_LABELS)
const LAND_AREA_RE = compileLabeledAreaRe(LAND_LABELS)

const TOTAL_WORDS =
  'gesamt|gesamte|insgesamt|total|totale|totales|totala|sammanlagd|sammanlagda|overall|combined' +
  '|łączna|łącznej|łącznie|celková|celkova|összes|bendras|ukupna|totala'
const LAND_OBJECT_WORDS =
  'grundstück|grundstueck|liegenschaft|flurstück|flurstueck|parzelle|grundbesitz' +
  '|fastighet(?:en)?|skifte|tomt|markareal(?:en)?|lantbruksenhet(?:en)?' +
  '|plot|property|parcel|lot|land' +
  '|terrain|parcelle|bien' +
  '|terreno|finca|parcela|solar' +
  '|terreno|fondo|particella' +
  '|działka|nieruchomość|gruntu|pozemek|parcela|telek|sklypas|zemljište|zemljiste'
const LAND_TOTAL_AREA_LABELS =
  'gesamt(?:fläche|flaeche|areal)(?:\\s+(?:grundstück|grundstueck|liegenschaft|flurstück|flurstueck))?' +
  '|(?:grundstück|grundstueck|liegenschaft|flurstück|flurstueck)\\s+gesamt(?:fläche|flaeche|areal)' +
  '|gesamt(?:e)?\\s+grundstücks(?:fläche|größe)|gesamt(?:e)?\\s+grundstuecks(?:flaeche|groesse)' +
  '|grundstücks(?:fläche|größe)\\s+gesamt|grundstuecks(?:flaeche|groesse)\\s+gesamt' +
  '|gesamt(?:e)?\\s+(?:fläche|flaeche|areal)|fläche\\s+gesamt|flaeche\\s+gesamt' +
  `|(?:${TOTAL_WORDS})\\s+(?:${LAND_LABELS})` +
  `|(?:${LAND_LABELS})\\s+(?:${TOTAL_WORDS})`
const AREA_NOUNS =
  'fläche|flaeche|areal|area|surface|superficie|powierzchni\\S*|plocha|terület|plotas|površin\\S*|povrsin\\S*'
const APPROX = '(?:ca\\.?|circa|approx\\.?|approximately|about)?'
const WORD_END = '(?![a-zäöüåéèêàáíóúñçąćęłńóśźż\\d])'
const LAND_TOTAL_AREA_RES = [
  // "Lantbruksenhet om 30 607 m²" — Kronofogden uses this for the
  // property/land unit total. Keep it before the looser prose patterns so a
  // later building-area sentence ("totalt 563 m² Byggnadsarea") can't win.
  new RegExp(
    `(?:lantbruksenhet(?:en)?)${WORD_END}\\s+(?:om|på)\\s*${APPROX}\\s*(${AREA_TOKEN})(?![a-zäöü\\d\\u0370-\\u03ff])`,
    'i',
  ),
  // "Grundstück bestehend aus einer Parzelle mit einer Fläche von ca. 18,1 ha"
  // "Fastighet bestående av ett skifte med en areal om ca 18,1 ha"
  new RegExp(
    `(?:${LAND_OBJECT_WORDS})${WORD_END}[^.\\n]{0,180}?` +
      `(?:bestehend|bestående|bestar|består|consisting|compris|comprenant|compuest[oa]|composto|composta|składa|sklada|tvořen|tvoren|sastoji)[^.\\n]{0,140}?` +
      `(?:${AREA_NOUNS})` +
      `(?:\\s+(?:von|om|på|of|de|di|o|:))?\\s*${APPROX}\\s*(${AREA_TOKEN})(?![a-zäöü\\d\\u0370-\\u03ff])`,
    'i',
  ),
  // "Gesamtfläche Grundstück: 18,1 ha", "total surface du terrain 18,1 ha"
  new RegExp(
    `(?:${LAND_TOTAL_AREA_LABELS})\\D{0,24}?(${AREA_TOKEN})(?![a-zäöü\\d\\u0370-\\u03ff])`,
    'i',
  ),
  // "Grundstück umfasst 18,1 ha, davon ..." / "property totals 18.1 ha, of which ..."
  new RegExp(
    `(?:${LAND_OBJECT_WORDS})${WORD_END}[^.\\n]{0,80}?` +
      `(?:umfasst|beträgt|betraegt|uppgår\\s+till|omfattar|totals?|covers?|comprises|comprend|comprende|obejmuje|wynosi)${WORD_END}` +
      `\\D{0,24}?(${AREA_TOKEN})(?![a-zäöü\\d\\u0370-\\u03ff])`,
    'i',
  ),
]

export function findLivingAreaSqm(text: string): number | null {
  return findLabeledArea(text, LIVING_AREA_RE)
}

export function findTotalLandAreaSqm(text: string): number | null {
  for (const re of LAND_TOTAL_AREA_RES) {
    const area = findLabeledArea(text, re)
    if (area != null) return area
  }
  return null
}

export function findLandAreaSqm(text: string): number | null {
  return findTotalLandAreaSqm(text) ?? findLabeledArea(text, LAND_AREA_RE)
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
  // French — "pièces" also means "documents" in legal prose ("les 3 pièces
  // jointes", "pièces du dossier"); the lookaheads veto those readings. The
  // (?![a-z]) stops backtracking into "pièce" + literal "s", which would
  // sidestep the document lookahead.
  '|pièces?(?![a-z])(?!\\s+(?:jointes?|annexées?|justificatives?|du\\s+dossier))' +
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
