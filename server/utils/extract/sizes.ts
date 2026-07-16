// Deterministic size/number parsing for the rules extraction pass. Conservative
// by design: it only matches clearly labeled values and bails to null otherwise,
// leaving ambiguous text to the LLM fallback. Mis-extraction is worse than a
// miss here, so the patterns forbid digits between a label and its value.

/** Parse a German-formatted number ("1.234,56" → 1234.56, "1.500" → 1500). */
function parseGermanNumber(raw: string): number | null {
  let s = raw.trim()
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.')
  } else if (!/^\d+\.\d{1,2}$/.test(s)) {
    // A single dot with a 1–2 digit fraction ("2.5") is a decimal point;
    // groups of 3 digits ("1.500", "1.234.567") are thousands separators.
    s = s.replace(/\./g, '')
  }
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : null
}

// A number immediately followed by an area unit. The negative lookahead stops
// "m2" matching "m2x", "ha" matching "haus", and (Greek) "τμ" matching the
// start of "τμήμα" (a common word meaning "section/part" — Ͱ-Ͽ
// covers Greek letters, which plain [a-z] doesn't).
const NUM = '\\d[\\d.]*(?:,\\d+)?'
// Greek listings write m² as "τ.μ." (τετραγωνικά μέτρα), sometimes without dots.
const AREA_TOKEN = `${NUM}\\s*(?:m²|m2|qm|kvm|ha|τ\\.?μ\\.?)`
const AREA_RE = new RegExp(`(${NUM})\\s*(m²|m2|qm|kvm|ha|τ\\.?μ\\.?)(?![a-z\\d\\u0370-\\u03ff])`, 'i')

/** "140 m²" → 140, "2,5 ha" → 25000, "214.000,00 Euro" → null. */
export function parseAreaValue(text: string): number | null {
  const m = text.match(AREA_RE)
  if (!m || !m[1] || !m[2]) return null
  const value = parseGermanNumber(m[1])
  if (value == null) return null
  return m[2].toLowerCase() === 'ha' ? value * 10000 : value
}

/** Find the area value that directly follows one of the given labels. */
function findLabeledArea(text: string, labelAlternation: string): number | null {
  // The lookahead stops the unit matching inside a word ("Grundstück mit
  // 1 Haus" must not read "1 Ha" as one hectare, "2 τμήματα" not as 2 τ.μ.).
  const re = new RegExp(
    `(?:${labelAlternation})\\D{0,14}?(${AREA_TOKEN})(?![a-zäöü\\d\\u0370-\\u03ff])`,
    'i',
  )
  const m = text.match(re)
  return m && m[1] ? parseAreaValue(m[1]) : null
}

const LIVING_LABELS =
  'wohnfläche|wohnnutzfläche|wohn-?/?nutzfläche|wohnfl\\.?|wfl\\.?' +
  // Czech
  '|podlahová plocha|užitná plocha|obytná plocha|plocha bytu' +
  // Polish
  '|powierzchnia użytkowa|powierzchnia mieszkalna' +
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
  // Greek
  '|επιφάνεια κατοικίας|επιφάνεια διαμερίσματος|εμβαδόν κατοικίας'

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
  // Greek
  '|έκταση οικοπέδου|επιφάνεια οικοπέδου|εμβαδόν οικοπέδου'

export function findLivingAreaSqm(text: string): number | null {
  return findLabeledArea(text, LIVING_LABELS)
}

export function findLandAreaSqm(text: string): number | null {
  return findLabeledArea(text, LAND_LABELS)
}

// The fallback patterns ("label then number") must not fire on compounds
// ("Wohnzimmer", "2 Schlafzimmer") — hence the negative lookbehind — and the
// gap between label and number must be letter-free so prose like
// "Wohneinheit Nr. 5" isn't read as a count. The number-first patterns are
// safe: NUM directly precedes the label, so a compound can't match.

export function findRooms(text: string): number | null {
  let m = text.match(new RegExp(`(${NUM})\\s*(?:zimmer|zi\\.)`, 'i'))
  if (m && m[1]) return parseGermanNumber(m[1])
  m = text.match(new RegExp(`(?<![a-zäöüß])zimmer[^a-zäöüß\\d]{0,6}?(${NUM})`, 'i'))
  if (m && m[1]) return parseGermanNumber(m[1])
  return null
}

export function findUnits(text: string): number | null {
  let m = text.match(/(\d+)\s*wohneinheiten?/i)
  if (m && m[1]) return parseInt(m[1], 10)
  m = text.match(/(?<![a-zäöüß])wohneinheiten?[^a-zäöüß\d]{0,6}?(\d+)/i)
  if (m && m[1]) return parseInt(m[1], 10)
  return null
}
