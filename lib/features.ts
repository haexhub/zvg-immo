// Ausstattung (features) einer Immobilie — kontrolliertes Vokabular (kein
// Freitext), damit Filter/Analyse auswertbar bleiben. Reines LLM-Vokabular wie
// condition.ts (kein regelbasierter Klassifizierer).

export type Feature =
  | 'balkon'
  | 'terrasse'
  | 'garten'
  | 'garage'
  | 'stellplatz'
  | 'keller'
  | 'dachgeschoss'
  | 'aufzug'
  | 'einbaukueche'
  | 'kamin'
  | 'barrierefrei'
  | 'zentralheizung'
  | 'fussbodenheizung'
  | 'denkmalschutz'
  | 'vermietet'

/** Runtime-Liste der Feature-Union — für LLM-Schema-Enum, Validierung und die
 *  Filter-Checkbox-Liste (TypeScript kann eine Union nicht zur Laufzeit aufzählen). */
export const FEATURES: readonly Feature[] = [
  'balkon',
  'terrasse',
  'garten',
  'garage',
  'stellplatz',
  'keller',
  'dachgeschoss',
  'aufzug',
  'einbaukueche',
  'kamin',
  'barrierefrei',
  'zentralheizung',
  'fussbodenheizung',
  'denkmalschutz',
  'vermietet',
]
