import { CONDITIONS } from '~/lib/condition'
import { FEATURES } from '~/lib/features'
import { PHOTO_CATEGORIES } from '~/lib/photo'
import { PROPERTY_TYPES } from '~/lib/property-type'

export const UNIVERSAL_AUCTION_SCHEMA_VERSION = 2
export const UNIVERSAL_AUCTION_SCHEMA_NAME = 'universal_auction_extraction_v2'
export const UNIVERSAL_AUCTION_SCHEMA_ID = `https://zvg-immo.local/schemas/${UNIVERSAL_AUCTION_SCHEMA_NAME}.json`

export const SYSTEM_PROMPT =
  'Du übersetzt chaotische, länderspezifische Texte und Dokumente zu Immobilienauktionen ' +
  'in ein universelles JSON-Format. Die Eingabe kann deutsch, spanisch, italienisch, ' +
  'französisch, niederländisch, tschechisch, polnisch, bosnisch, ungarisch, litauisch, ' +
  'lettisch, estnisch, schwedisch, finnisch, dänisch, isländisch oder eine andere ' +
  'europäische Sprache enthalten. Arbeite semantisch, nicht wortwörtlich: ordne lokale ' +
  'Auktions-, Gerichts-, Grundstücks- und Immobilienbegriffe den kanonischen Schemafeldern ' +
  'zu und gib Enum-Werte exakt in den erlaubten normalisierten Codes zurück. Freitexte ' +
  'wie documentSummary, biddingNotes, renovationNotes, insights.summary und planningNotes ' +
  'gibst du auf Deutsch zurück; kurze O-Ton-Beträge in marketValueText dürfen in der ' +
  'Originalsprache/-schreibweise bleiben. ' +
  'Gib die Objektart als eine der erlaubten Kategorien ' +
  'zurück und Flächen in Quadratmetern (Hektar in m² umrechnen: 1 ha = 10000 m²). ' +
  'Wohnfläche und Grundstücksfläche strikt getrennt halten. Wenn ein Wert nicht ' +
  'eindeutig im Text steht, gib null zurück — niemals raten. ' +
  'Extrahiere Schlafzimmer, Badezimmer, Etage/Geschosslage, Badewanne, Dusche und ' +
  'Heizungsart nur, wenn sie ausdrücklich genannt werden. Bei Etage/Geschosslage ' +
  'kurze Angaben wie "EG", "1. OG", "Dachgeschoss" verwenden. Badewanne/Dusche ' +
  'als true/false nur zurückgeben, wenn das Vorhandensein oder Nichtvorhandensein ' +
  'klar genannt ist; sonst null. Heizungsart/Energieträger als kurzen deutschen ' +
  'Freitext zurückgeben, z. B. "Gaszentralheizung", "Ölheizung", "Wärmepumpe" ' +
  'oder "Ofenheizung"; sonst null. ' +
  'Gib die Zimmeranzahl nur für tatsächlich vorhandene, bereits errichtete Bebauung ' +
  'zurück. Eine im Bebauungsplan oder einer Baugenehmigung genannte zulässige oder ' +
  'genehmigte Kapazität (z. B. "bis zu 250 Hotelzimmer laut Baugenehmigung") ist keine ' +
  'existierende Zimmerzahl — ein genehmigtes, aber noch unbebautes Grundstück hat null ' +
  'Zimmer. ' +
  'Gib eine Sicherheitsleistung nur zurück, wenn ein konkreter Geldbetrag in der ' +
  'Landeswährung der Anzeige im Text genannt wird (z. B. eine von der gesetzlichen ' +
  '10%-Regel abweichende Festsetzung) — niemals aus einem Prozentsatz berechnen ' +
  'oder in eine andere Währung umrechnen, sonst null. ' +
  'Gib den im Gutachten genannten Verkehrswert (Gesamtschätzwert der ' +
  'Immobilie) in der Landeswährung der Anzeige zurück, falls explizit ' +
  'genannt, sonst null — nicht zu verwechseln mit dem Bodenrichtwert ' +
  '(EUR/m² nur für das Grundstück, siehe insights). Werden für mehrere ' +
  'Flurstücke/Teilgrundstücke desselben Versteigerungsobjekts jeweils ' +
  'eigene Verkehrswerte genannt, ohne dass ein gemeinsamer Gesamtwert ' +
  'explizit dasteht, addiere sie zu einem Gesamtwert (das Objekt wird als ' +
  'ein Los versteigert). In marketValueText den O-Ton-Betrag als kurzen ' +
  'Freitext, bei einer Summe mit kurzem Hinweis (z. B. "78.000 + 8.000 EUR, ' +
  'Summe mehrerer Flurstücke"), sonst null. ' +
  'Gib in biddingNotes einen kurzen Hinweis zurück, falls der Text etwas ' +
  'Ungewöhnliches zum Bietverfahren nennt (abweichende Sicherheitsleistung, ' +
  'ungewöhnliche Zahlungsfrist o. Ä.), sonst null. ' +
  'Gib außerdem den Zustand als eine der erlaubten Kategorien zurück, nur wenn er ' +
  'eindeutig aus dem Text hervorgeht (z.B. "kernsaniert"/"neuwertig" → neuwertig, ' +
  '"Sanierungsstau" → sanierungsbeduerftig, "renovierungsbedürftig" → renovierungsbeduerftig), sonst null. ' +
  'Gib eine Liste erkannter Ausstattungsmerkmale zurück — nur Merkmale, die explizit ' +
  'im Text genannt werden (Negation beachten, z.B. "kein Balkon" nicht aufnehmen), ' +
  'sonst eine leere Liste. Niemals raten. ' +
  'Gib das Baujahr zurück, falls im Text eindeutig genannt, sonst null. Gib das Jahr der ' +
  'letzten Sanierung/Modernisierung zurück, falls eindeutig genannt, sonst null, und in ' +
  'renovationNotes einen kurzen Freitext-Hinweis dazu, sonst null. ' +
  'Erstelle außerdem in documentSummary eine ausführliche, sachliche Zusammenfassung ' +
  'aus ALLEN bereitgestellten objektbezogenen Dokumenten und der Anzeige. Führe die ' +
  'wesentlichen Angaben zu Objekt und Nutzung, Lage, Flächen, Bauweise und Zustand, ' +
  'Modernisierungen, Mängeln, rechtlichen oder planerischen Besonderheiten sowie ' +
  'Wertermittlung in gut lesbaren Absätzen zusammen. Widersprüche zwischen Dokumenten ' +
  'kenntlich machen und keine Tatsachen ergänzen. Allgemeine, nicht objektspezifische ' +
  'Biet- oder Gerichtshinweise nicht wiederholen. Ziel sind etwa 5 bis 10 kompakte ' +
  'Absätze; null nur, wenn außer dem bereits gelieferten Anzeigentext keine verwertbaren ' +
  'Objektinformationen vorhanden sind. ' +
  'Extrahiere zusätzlich, sofern im Gutachten enthalten, eine reichhaltigere Einschätzung ' +
  '(insights): defects (Mängel/Schäden/Sanierungsstau), encumbrances (Belastungen wie ' +
  'Wohnrecht/Nießbrauch/Dienstbarkeiten), landValueEurPerSqm (Bodenrichtwert in EUR/m²), ' +
  'construction (Bauweise/Konstruktion), locationCharacter (Lagecharakter) und summary ' +
  '(kurze Gesamteinschätzung, 2-4 Sätze). Gib insights insgesamt als null zurück, wenn das ' +
  'Gutachten keine dieser Angaben enthält. Niemals raten. ' +
  'Extrahiere außerdem, sofern im Gutachten enthalten (typischerweise in einer Tabelle ' +
  '"weitere Zustandsmerkmale" oder ähnlich betitelt), planerische/rechtliche Hinweise ' +
  '(planningNotes) als kurzen Freitext je Feld: monumentProtection (Denkmalschutz, O-Ton), ' +
  'contamination (Altlasten), developmentPlan (Bauleitplanung/Bebauungsplan-Festsetzung), ' +
  'landConsolidation (Bodenordnung), developmentCharges (Erschließungs-/Ausbaubeiträge), ' +
  'redevelopmentArea (Sanierungsgebiet), conservationArea (Erhaltungsgebiet). Ein "kein(e) ' +
  'X bekannt/vorhanden"-Hinweis zählt als vorhandene Angabe (kurz wiedergeben), nicht als ' +
  'null — null nur wenn das Gutachten das Thema gar nicht erwähnt. Extrahiere außerdem, ' +
  'sofern im Gutachten enthalten (z. B. Abschnitt "wertmethodische Aufteilung des ' +
  'Grundstückes" oder "Aufteilung auf die Flurstücke"), die Aufteilung des Grundstücks in ' +
  'landParcels: eine Liste aus label (Teilflächen- oder Flurstücksbezeichnung, z. B. ' +
  '"Teilfläche A" oder "743/1"), areaSqm (Fläche in m², oder null) und use (Nutzung/Zweck, ' +
  'z. B. "gewerbliche Baufläche", oder null). Leere Liste, wenn keine Aufteilung genannt ' +
  'wird. Gib planningNotes insgesamt als null zurück, wenn keines der Felder und keine ' +
  'landParcels-Einträge im Gutachten stehen. Niemals raten. ' +
  'Falls Kandidatenbilder mitgesendet werden (jeweils mit vorangestelltem "Bild N:"-Label), ' +
  'kuratiere jedes Bild im photos-Array: photoIndex (der Index aus dem Label), category ' +
  '(aussen/innen/grundriss/lageplan/sonstiges), caption (kurze Bildunterschrift oder null) ' +
  'und isPropertyPhoto (true nur bei einem echten Objektfoto, also Außen-/Innenansicht der ' +
  'Immobilie; false bei Lageplan, Grundriss, Wappen, Deckblatt oder Textseite). Wurden keine ' +
  'Bilder mitgesendet, gib ein leeres photos-Array zurück.'

export const UNIVERSAL_AUCTION_SCHEMA = {
  description:
    'Kanonisches, länder- und sprachunabhängiges Zielformat für aus Auktionstexten und Dokumenten extrahierte Immobilien-Eckdaten.',
  type: 'object',
  additionalProperties: false,
  properties: {
    propertyType: {
      type: ['string', 'null'],
      enum: [...PROPERTY_TYPES, null],
      description: 'Objektart, oder null wenn unklar.',
    },
    landAreaSqm: { type: ['number', 'null'], description: 'Grundstücksfläche in m².' },
    livingAreaSqm: { type: ['number', 'null'], description: 'Wohnfläche in m².' },
    rooms: {
      type: ['number', 'null'],
      description:
        'Zimmeranzahl der tatsächlich existierenden Bebauung, oder null. Genehmigte/zulässige Kapazität aus Bebauungsplan oder Baugenehmigung zählt nicht.',
    },
    bedrooms: { type: ['number', 'null'], description: 'Schlafzimmeranzahl, oder null wenn unklar.' },
    bathrooms: { type: ['number', 'null'], description: 'Badezimmeranzahl, oder null wenn unklar.' },
    floor: {
      type: ['string', 'null'],
      description: 'Etage/Geschosslage bei Wohnungen als kurzer Text (z. B. EG, 1. OG, Dachgeschoss), oder null.',
    },
    bathroomHasTub: {
      type: ['boolean', 'null'],
      description: 'true/false wenn Badewanne ausdrücklich vorhanden/nicht vorhanden ist, sonst null.',
    },
    bathroomHasShower: {
      type: ['boolean', 'null'],
      description: 'true/false wenn Dusche ausdrücklich vorhanden/nicht vorhanden ist, sonst null.',
    },
    heating: {
      type: ['string', 'null'],
      description: 'Heizungsart/Energieträger als kurzer deutscher Freitext, oder null.',
    },
    units: { type: ['integer', 'null'], description: 'Anzahl Wohneinheiten.' },
    securityDeposit: {
      type: ['number', 'null'],
      description: 'Explizit genannte Sicherheitsleistung in der Landeswährung der Anzeige, oder null.',
    },
    marketValueEur: {
      type: ['number', 'null'],
      description:
        'Im Gutachten genannter Verkehrswert (Gesamtschätzwert) in der Landeswährung der Anzeige, oder null. Nicht der Bodenrichtwert. Bei mehreren Flurstücken mit je eigenem Verkehrswert und ohne genannten Gesamtwert: Summe.',
    },
    marketValueText: {
      type: ['string', 'null'],
      description: 'O-Ton-Betrag zu marketValueEur, oder null.',
    },
    biddingNotes: {
      type: ['string', 'null'],
      description: 'Kurzer Hinweis zu Besonderheiten des Bietverfahrens, oder null.',
    },
    condition: {
      type: ['string', 'null'],
      enum: [...CONDITIONS, null],
      description: 'Zustand der Immobilie, oder null wenn unklar.',
    },
    features: {
      type: 'array',
      items: { type: 'string', enum: FEATURES },
      description: 'Erkannte Ausstattungsmerkmale, leer wenn keine eindeutig genannt.',
    },
    yearBuilt: { type: ['integer', 'null'], description: 'Baujahr, oder null wenn unklar.' },
    lastRenovationYear: {
      type: ['integer', 'null'],
      description: 'Jahr der letzten Sanierung/Modernisierung, oder null wenn unklar.',
    },
    renovationNotes: {
      type: ['string', 'null'],
      description: 'Kurzer Hinweis zu Sanierung/Modernisierung, oder null.',
    },
    insights: {
      type: ['object', 'null'],
      additionalProperties: false,
      description: 'Reichhaltigere Einschätzung aus dem Gutachten, oder null wenn nichts Nennenswertes.',
      properties: {
        defects: {
          type: 'array',
          items: { type: 'string' },
          description: 'Mängel/Schäden/Sanierungsstau, leer wenn keine genannt.',
        },
        encumbrances: {
          type: 'array',
          items: { type: 'string' },
          description: 'Belastungen (Wohnrecht, Nießbrauch, Dienstbarkeiten, ...), leer wenn keine genannt.',
        },
        landValueEurPerSqm: {
          type: ['number', 'null'],
          description: 'Bodenrichtwert in EUR/m², oder null.',
        },
        construction: { type: ['string', 'null'], description: 'Bauweise/Konstruktion, oder null.' },
        locationCharacter: { type: ['string', 'null'], description: 'Lagecharakter, oder null.' },
        summary: { type: ['string', 'null'], description: 'Kurze Gesamteinschätzung (2-4 Sätze), oder null.' },
      },
      required: [
        'defects',
        'encumbrances',
        'landValueEurPerSqm',
        'construction',
        'locationCharacter',
        'summary',
      ],
    },
    planningNotes: {
      type: ['object', 'null'],
      additionalProperties: false,
      description: 'Planerische/rechtliche Hinweise aus dem Gutachten, oder null wenn nichts Nennenswertes.',
      properties: {
        monumentProtection: { type: ['string', 'null'], description: 'Denkmalschutz-Hinweis (O-Ton), oder null.' },
        contamination: { type: ['string', 'null'], description: 'Altlasten-Hinweis, oder null.' },
        developmentPlan: { type: ['string', 'null'], description: 'Bauleitplanung/B-Plan-Festsetzung, oder null.' },
        landConsolidation: { type: ['string', 'null'], description: 'Bodenordnung, oder null.' },
        developmentCharges: {
          type: ['string', 'null'],
          description: 'Erschließungs-/Ausbaubeiträge, oder null.',
        },
        redevelopmentArea: { type: ['string', 'null'], description: 'Sanierungsgebiet, oder null.' },
        conservationArea: { type: ['string', 'null'], description: 'Erhaltungsgebiet, oder null.' },
        landParcels: {
          type: 'array',
          description: 'Aufteilung des Grundstücks in Teilflächen/Flurstücke, leer wenn keine genannt.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', description: 'Teilflächen- oder Flurstücksbezeichnung.' },
              areaSqm: { type: ['number', 'null'], description: 'Fläche in m², oder null.' },
              use: { type: ['string', 'null'], description: 'Nutzung/Zweck, oder null.' },
            },
            required: ['label', 'areaSqm', 'use'],
          },
        },
      },
      required: [
        'monumentProtection',
        'contamination',
        'developmentPlan',
        'landConsolidation',
        'developmentCharges',
        'redevelopmentArea',
        'conservationArea',
        'landParcels',
      ],
    },
    documentSummary: {
      type: ['string', 'null'],
      description:
        'Ausführliche sachliche Zusammenfassung aller bereitgestellten objektbezogenen Dokumente in etwa 5 bis 10 kompakten Absätzen, oder null.',
    },
    photos: {
      type: 'array',
      description:
        'Kuratierung der mitgesendeten Kandidatenbilder ("Bild N:"-Label), höchstens ein Eintrag pro Bild; leeres Array wenn keine Bilder mitgesendet wurden.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          photoIndex: { type: 'integer', description: '0-basierter Index des Bildes (siehe "Bild N:"-Label).' },
          category: {
            type: 'string',
            enum: PHOTO_CATEGORIES,
            description: 'Kategorie des Bildes.',
          },
          caption: { type: ['string', 'null'], description: 'Kurze Bildunterschrift, oder null.' },
          isPropertyPhoto: {
            type: 'boolean',
            description:
              'true bei echtem Objektfoto (Außen-/Innenansicht), false bei Lageplan/Grundriss/Wappen/Deckblatt/Textseite.',
          },
        },
        required: ['photoIndex', 'category', 'caption', 'isPropertyPhoto'],
      },
    },
  },
  required: [
    'propertyType',
    'landAreaSqm',
    'livingAreaSqm',
    'rooms',
    'bedrooms',
    'bathrooms',
    'floor',
    'bathroomHasTub',
    'bathroomHasShower',
    'heating',
    'units',
    'securityDeposit',
    'marketValueEur',
    'marketValueText',
    'biddingNotes',
    'condition',
    'features',
    'yearBuilt',
    'lastRenovationYear',
    'renovationNotes',
    'insights',
    'planningNotes',
    'documentSummary',
    'photos',
  ],
} as const
