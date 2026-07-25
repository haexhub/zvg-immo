import type { AttachmentKind } from '~/types/auction'

const RULES: ReadonlyArray<[RegExp, AttachmentKind]> = [
  // Checked before 'announcement': "tac" in that rule is a substring of the
  // German word "Gutachten", so checking it first would mis-tag every
  // Gutachten attachment (label or filename containing "Gutachten") as a
  // Bekanntmachung instead.
  [/gutacht|verkehrswert|expert|expertise|estim|sch[aä]tz/i, 'appraisal'],
  [/edikt|bekanntmachung|verlautbarung|tac|cahier|terms|conditions|verkoopsvoorwaarden|huutokauppaehdot|auktionsvillkor/i, 'announcement'],
  [/expos[ée]|brochure|prospect|myyntiesite|salgsopstilling/i, 'brochure'],
  // Checked before 'photo': zvg-portal sometimes labels administrative PDFs
  // (bank-details sheets, registration forms, entry-control notices) "Foto"
  // — seen live as "Kontoverbindung-Sicherheitsleistung" and "Hinweis
  // Wartezeiten aufgrund Einlasskontrolle" tagged Foto, which would inflate
  // photoCount and get picked as a thumbnail.
  [/kontoverbindung|sicherheitsleistung|merkblatt|anmeldeformular|einlasskontrolle|wartezeit/i, 'other'],
  [/foto|bild|photo|picture|image/i, 'photo'],
]

export function classifyAttachment(...terms: (string | null | undefined)[]): AttachmentKind {
  const haystack = terms.filter(Boolean).join(' ')
  for (const [re, kind] of RULES) if (re.test(haystack)) return kind
  return 'other'
}
