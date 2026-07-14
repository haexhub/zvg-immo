import type { AttachmentKind } from '~/types/auction'

const RULES: ReadonlyArray<[RegExp, AttachmentKind]> = [
  [/edikt|bekanntmachung|verlautbarung|tac|cahier|terms|conditions|verkoopsvoorwaarden|huutokauppaehdot|auktionsvillkor/i, 'bekanntmachung'],
  [/gutacht|verkehrswert|expert|expertise|estim|sch[aä]tz/i, 'gutachten'],
  [/expos[ée]|brochure|prospect|myyntiesite|salgsopstilling/i, 'exposee'],
  [/foto|bild|photo|picture|image/i, 'foto'],
]

export function classifyAttachment(...terms: (string | null | undefined)[]): AttachmentKind {
  const haystack = terms.filter(Boolean).join(' ')
  for (const [re, kind] of RULES) if (re.test(haystack)) return kind
  return 'sonstiges'
}
