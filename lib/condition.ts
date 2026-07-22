// Zustand (condition) einer Immobilie — reines LLM-Vokabular (kein
// regelbasierter Klassifizierer wie bei property-type.ts, da der Zustand fast
// immer als Prosa im Gutachten steht, nicht als strukturiertes Feld). Bewusst
// grob gehalten (5 Stufen), damit das LLM stabil klassifiziert und der Filter
// nutzbar bleibt.

/** Reihenfolge best → schlechtest — der Index dient dem Min-Zustand-Filter. */
export type Condition =
  | 'neuwertig'
  | 'gepflegt'
  | 'renovierungsbeduerftig'
  | 'sanierungsbeduerftig'
  | 'baufaellig'

/** Runtime-Liste der Condition-Union — für LLM-Schema-Enum, Validierung und den
 *  Min-Zustand-Filter (TypeScript kann eine Union nicht zur Laufzeit aufzählen). */
export const CONDITIONS: readonly Condition[] = [
  'neuwertig',
  'gepflegt',
  'renovierungsbeduerftig',
  'sanierungsbeduerftig',
  'baufaellig',
]
