import type { AttachmentKind } from '~/types/auction'

const RULES: ReadonlyArray<[RegExp, AttachmentKind]> = [
  // Checked before 'bekanntmachung': "tac" in that rule is a substring of the
  // German word "Gutachten", so checking it first would mis-tag every
  // Gutachten attachment (label or filename containing "Gutachten") as a
  // Bekanntmachung instead.
  [/gutacht|verkehrswert|expert|expertise|estim|sch[aä]tz/i, 'gutachten'],
  [/edikt|bekanntmachung|verlautbarung|tac|cahier|terms|conditions|verkoopsvoorwaarden|huutokauppaehdot|auktionsvillkor/i, 'bekanntmachung'],
  [/expos[ée]|brochure|prospect|myyntiesite|salgsopstilling/i, 'exposee'],
  [/foto|bild|photo|picture|image/i, 'foto'],
]

export function classifyAttachment(...terms: (string | null | undefined)[]): AttachmentKind {
  const haystack = terms.filter(Boolean).join(' ')
  for (const [re, kind] of RULES) if (re.test(haystack)) return kind
  return 'sonstiges'
}
