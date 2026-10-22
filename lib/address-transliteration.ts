import type { ContentTargetLang } from '~/lib/content-language'

// Readable Latin form of a Cyrillic (Bulgarian) address for list views, where
// no LLM translation exists yet: place names are transliterated with the
// official Bulgarian system (Streamlined System, 2009), and the common
// address abbreviations become the reader's own terms. The detail page keeps
// translating the full address via the LLM.

const CYRILLIC = /[Ѐ-ӿ]/

const LETTERS: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya',
  // Russian/Ukrainian letters that occasionally show up in names.
  ё: 'yo', ы: 'y', э: 'e', є: 'ye', і: 'i', ї: 'yi', ґ: 'g',
}

type Term = Record<ContentTargetLang, string>

// Longest first, so 'ж.к.' wins over a bare 'к.'-like overlap. Matched as
// whole words only; the abbreviations keep their trailing dot in the source.
const TERMS: Array<[string, Term]> = [
  ['местност', { de: 'Flur', en: 'locality' }],
  ['община', { de: 'Gemeinde', en: 'municipality' }],
  ['област', { de: 'Bezirk', en: 'province' }],
  ['булевард', { de: 'Boulevard', en: 'blvd.' }],
  ['улица', { de: 'Str.', en: 'St.' }],
  ['град', { de: 'Stadt', en: 'town' }],
  ['село', { de: 'Dorf', en: 'village' }],
  ['ж.к.', { de: 'Wohnviertel', en: 'housing estate' }],
  ['общ.', { de: 'Gemeinde', en: 'municipality' }],
  ['обл.', { de: 'Bezirk', en: 'province' }],
  ['бул.', { de: 'Boulevard', en: 'blvd.' }],
  ['ул.', { de: 'Str.', en: 'St.' }],
  ['гр.', { de: 'Stadt', en: 'town' }],
  ['кв.', { de: 'Viertel', en: 'quarter' }],
  ['вх.', { de: 'Eingang', en: 'entrance' }],
  ['ет.', { de: 'Etage', en: 'floor' }],
  ['ап.', { de: 'Whg.', en: 'apt.' }],
  ['жк', { de: 'Wohnviertel', en: 'housing estate' }],
  ['с.', { de: 'Dorf', en: 'village' }],
]

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A term ending in '.' already ends the word; one ending in a letter must not
// continue into a longer word ('град' is not the start of 'градина').
const TERM_PATTERN = new RegExp(
  `(?<!\\p{L})(${TERMS.map(([term]) => escape(term) + (term.endsWith('.') ? '' : '(?!\\p{L})')).join('|')})`,
  'giu',
)
const TERM_BY_SOURCE = new Map(TERMS.map(([term, target]) => [term, target]))

function transliterateWord(word: string): string {
  // Official exception: word-final 'ия' is 'ia', not 'iya' (София -> Sofia).
  // Same length, so `lower[i]` still lines up with `word[i]`.
  const lower = word.toLowerCase().replace(/ия$/, 'ia')
  // An all-caps word stays all caps ('ВАЗОВ' -> 'VAZOV'); a capitalized one
  // only capitalizes its first Latin letter ('Шумен' -> 'Shumen').
  const allCaps = word.length > 1 && word === word.toUpperCase()
  let out = ''
  for (let i = 0; i < lower.length; i++) {
    const latin = LETTERS[lower[i]!] ?? lower[i]!
    const upper = word[i] !== lower[i] && word[i] === word[i]!.toUpperCase()
    if (!upper) out += latin
    else out += allCaps ? latin.toUpperCase() : latin.charAt(0).toUpperCase() + latin.slice(1)
  }
  return out
}

/** The address in Latin script for `lang` readers, or the address unchanged
 *  when it contains no Cyrillic. */
export function latinAddress(address: string, lang: ContentTargetLang): string {
  if (!CYRILLIC.test(address)) return address
  const localized = address.replace(TERM_PATTERN, (match) => TERM_BY_SOURCE.get(match.toLowerCase())?.[lang] ?? match)
  return localized.replace(/[\p{Script=Cyrillic}]+/gu, transliterateWord)
}

type TranslatedTexts = Partial<Record<ContentTargetLang, { title: string | null; address: string | null }>>

/** Card/popover address: the stored LLM translation for `lang` when there is
 *  one, else the Latin transliteration. */
export function displayAuctionAddress(
  auction: { address: string | null; translations?: TranslatedTexts },
  lang: ContentTargetLang,
): string | null {
  const translated = auction.translations?.[lang]?.address
  if (translated) return translated
  return auction.address ? latinAddress(auction.address, lang) : null
}

/** Card/popover title: the stored LLM translation for `lang` when there is
 *  one. A transliterated sentence would still be unreadable, so the title
 *  otherwise stays as published. */
export function displayAuctionTitle(
  auction: { title: string | null; translations?: TranslatedTexts },
  lang: ContentTargetLang,
): string | null {
  return auction.translations?.[lang]?.title || auction.title
}
