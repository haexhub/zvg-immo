import { describe, expect, it } from 'vitest'
import {
  buildParts,
  clampExtraction,
  parseExtractionResponse,
  resolveLlmConfig,
  SYSTEM_PROMPT,
  UNIVERSAL_AUCTION_SCHEMA,
  UNIVERSAL_AUCTION_SCHEMA_ID,
  UNIVERSAL_AUCTION_SCHEMA_NAME,
  UNIVERSAL_AUCTION_SCHEMA_VERSION,
} from './llm'

describe('universal auction extraction schema', () => {
  it('exposes the canonical schema identity and required fields', () => {
    expect(UNIVERSAL_AUCTION_SCHEMA_VERSION).toBe(1)
    expect(UNIVERSAL_AUCTION_SCHEMA_ID).toContain(UNIVERSAL_AUCTION_SCHEMA_NAME)
    expect(UNIVERSAL_AUCTION_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
    })
    expect(UNIVERSAL_AUCTION_SCHEMA.required).toContain('propertyType')
    expect(UNIVERSAL_AUCTION_SCHEMA.required).toContain('documentSummary')
  })

  it('instructs the LLM to normalize country-specific text into the universal JSON format', () => {
    expect(SYSTEM_PROMPT).toContain('universelles JSON-Format')
    expect(SYSTEM_PROMPT).toContain('polnisch')
    expect(SYSTEM_PROMPT).toContain('spanisch')
    expect(SYSTEM_PROMPT).toContain('Enum-Werte exakt')
    expect(SYSTEM_PROMPT).toContain('gibst du auf Deutsch zurück')
  })
})

describe('parseExtractionResponse', () => {
  it('returns the final_result tool_use input', () => {
    const resp = {
      content: [
        { type: 'tool_use', name: 'final_result', input: { propertyType: 'haus', landAreaSqm: 620 } },
      ],
    }
    expect(parseExtractionResponse(resp)).toEqual({ propertyType: 'haus', landAreaSqm: 620 })
  })

  it('returns null when no tool_use block is present', () => {
    expect(parseExtractionResponse({ content: [{ type: 'text', text: 'hi' }] })).toBeNull()
  })

  it('returns null for malformed responses', () => {
    expect(parseExtractionResponse(null)).toBeNull()
    expect(parseExtractionResponse({})).toBeNull()
    expect(parseExtractionResponse({ content: 'nope' })).toBeNull()
  })
})

describe('clampExtraction', () => {
  it('keeps plausible values and a valid propertyType', () => {
    expect(
      clampExtraction({
        propertyType: 'einfamilienhaus',
        landAreaSqm: 620,
        livingAreaSqm: 140,
        rooms: 5,
        units: 1,
        securityDeposit: 5000,
        biddingNotes: 'Abweichende Sicherheitsleistung von 5.000 EUR gefordert.',
        condition: 'gepflegt',
        features: ['balkon', 'garage'],
      }),
    ).toEqual({
      propertyType: 'einfamilienhaus',
      landAreaSqm: 620,
      livingAreaSqm: 140,
      rooms: 5,
      units: 1,
      securityDeposit: 5000,
      biddingNotes: 'Abweichende Sicherheitsleistung von 5.000 EUR gefordert.',
      condition: 'gepflegt',
      features: ['balkon', 'garage'],
      yearBuilt: null,
      lastRenovationYear: null,
      renovationNotes: null,
      insights: null,
      planningNotes: null,
      documentSummary: null,
      photoCuration: [],
      marketValueEur: null,
      marketValueText: null,
    })
  })

  it('nulls an unknown propertyType', () => {
    expect(clampExtraction({ propertyType: 'castle' }).propertyType).toBeNull()
  })

  it('rejects non-positive and absurd areas', () => {
    const r = clampExtraction({ landAreaSqm: 0, livingAreaSqm: -5 })
    expect(r.landAreaSqm).toBeNull()
    expect(r.livingAreaSqm).toBeNull()
    expect(clampExtraction({ landAreaSqm: 999_999_999_999 }).landAreaSqm).toBeNull()
  })

  it('coerces missing fields to null', () => {
    expect(clampExtraction({})).toEqual({
      propertyType: null,
      landAreaSqm: null,
      livingAreaSqm: null,
      rooms: null,
      units: null,
      securityDeposit: null,
      biddingNotes: null,
      condition: null,
      features: [],
      yearBuilt: null,
      lastRenovationYear: null,
      renovationNotes: null,
      insights: null,
      planningNotes: null,
      documentSummary: null,
      photoCuration: [],
      marketValueEur: null,
      marketValueText: null,
    })
  })

  it('drops non-numeric junk', () => {
    expect(clampExtraction({ landAreaSqm: 'big' as unknown as number }).landAreaSqm).toBeNull()
  })

  it('rejects a non-positive or absurd securityDeposit', () => {
    expect(clampExtraction({ securityDeposit: 0 }).securityDeposit).toBeNull()
    expect(clampExtraction({ securityDeposit: -100 }).securityDeposit).toBeNull()
    expect(clampExtraction({ securityDeposit: 999_999_999_999 }).securityDeposit).toBeNull()
  })

  it('keeps a plausible securityDeposit', () => {
    expect(clampExtraction({ securityDeposit: 3000 }).securityDeposit).toBe(3000)
  })

  it('rejects a non-positive or absurd marketValueEur', () => {
    expect(clampExtraction({ marketValueEur: 0 }).marketValueEur).toBeNull()
    expect(clampExtraction({ marketValueEur: -100 }).marketValueEur).toBeNull()
    expect(clampExtraction({ marketValueEur: 999_999_999_999 }).marketValueEur).toBeNull()
  })

  it('keeps a plausible marketValueEur and trims marketValueText', () => {
    expect(clampExtraction({ marketValueEur: 185_000 }).marketValueEur).toBe(185_000)
    expect(clampExtraction({ marketValueText: '  185.000 EUR laut Gutachten  ' }).marketValueText).toBe(
      '185.000 EUR laut Gutachten',
    )
    expect(clampExtraction({ marketValueText: '   ' }).marketValueText).toBeNull()
  })

  it('trims and caps biddingNotes, nulls blank/non-string values', () => {
    expect(clampExtraction({ biddingNotes: '  ein Hinweis  ' }).biddingNotes).toBe('ein Hinweis')
    expect(clampExtraction({ biddingNotes: '   ' }).biddingNotes).toBeNull()
    expect(clampExtraction({ biddingNotes: 42 as unknown as string }).biddingNotes).toBeNull()
    expect(clampExtraction({ biddingNotes: 'x'.repeat(500) }).biddingNotes).toHaveLength(300)
  })

  it('nulls an unknown condition', () => {
    expect(clampExtraction({ condition: 'ruin' }).condition).toBeNull()
  })

  it('keeps a valid condition', () => {
    expect(clampExtraction({ condition: 'baufaellig' }).condition).toBe('baufaellig')
  })

  it('filters unknown features and dedupes', () => {
    expect(
      clampExtraction({ features: ['balkon', 'balkon', 'unicorn-pool', 'garten'] }).features,
    ).toEqual(['balkon', 'garten'])
  })

  it('defaults features to an empty array when missing or malformed', () => {
    expect(clampExtraction({}).features).toEqual([])
    expect(clampExtraction({ features: 'balkon' as unknown as string[] }).features).toEqual([])
  })

  it('keeps in-range years and rounds them', () => {
    expect(clampExtraction({ yearBuilt: 1965 }).yearBuilt).toBe(1965)
    expect(clampExtraction({ yearBuilt: 1965.7 }).yearBuilt).toBe(1966)
    expect(clampExtraction({ lastRenovationYear: 2018 }).lastRenovationYear).toBe(2018)
  })

  it('rejects out-of-range and non-numeric years', () => {
    expect(clampExtraction({ yearBuilt: 1700 }).yearBuilt).toBeNull()
    expect(clampExtraction({ yearBuilt: new Date().getFullYear() + 1 }).yearBuilt).toBeNull()
    expect(clampExtraction({ yearBuilt: '1965' as unknown as number }).yearBuilt).toBeNull()
  })

  it('trims and caps renovationNotes, nulls blank/non-string values', () => {
    expect(clampExtraction({ renovationNotes: '  Dach 2019 neu  ' }).renovationNotes).toBe('Dach 2019 neu')
    expect(clampExtraction({ renovationNotes: '   ' }).renovationNotes).toBeNull()
    expect(clampExtraction({ renovationNotes: 'x'.repeat(500) }).renovationNotes).toHaveLength(300)
  })

  it('nulls insights when missing or not an object', () => {
    expect(clampExtraction({}).insights).toBeNull()
    expect(clampExtraction({ insights: 'nope' as unknown as object }).insights).toBeNull()
  })

  it('nulls insights when array-shaped or every field clamps away to empty', () => {
    expect(clampExtraction({ insights: [] as unknown as object }).insights).toBeNull()
    expect(
      clampExtraction({ insights: { defects: [], encumbrances: [], summary: '  ' } }).insights,
    ).toBeNull()
  })

  it('clamps insights fields: trims lists, caps counts/lengths, bounds land value', () => {
    const r = clampExtraction({
      insights: {
        defects: ['  Feuchtigkeit im Keller  ', '', 42, 'Dachschaden'],
        encumbrances: Array.from({ length: 30 }, (_, i) => `Belastung ${i}`),
        landValueEurPerSqm: 350,
        construction: '  Massivbau  ',
        locationCharacter: 'ruhige Wohnlage',
        summary: 's'.repeat(800),
      },
    })
    expect(r.insights).not.toBeNull()
    expect(r.insights!.defects).toEqual(['Feuchtigkeit im Keller', 'Dachschaden'])
    expect(r.insights!.encumbrances).toHaveLength(20)
    expect(r.insights!.landValueEurPerSqm).toBe(350)
    expect(r.insights!.construction).toBe('Massivbau')
    expect(r.insights!.summary).toHaveLength(500)
  })

  it('rejects a non-positive or absurd insights land value', () => {
    // Pair the invalid land value with a surviving field so `insights` stays
    // non-null and the land-value bounding itself is what's asserted.
    expect(
      clampExtraction({ insights: { landValueEurPerSqm: 0, construction: 'Massivbau' } }).insights!
        .landValueEurPerSqm,
    ).toBeNull()
    expect(
      clampExtraction({ insights: { landValueEurPerSqm: 9_999_999, construction: 'Massivbau' } })
        .insights!.landValueEurPerSqm,
    ).toBeNull()
  })

  it('nulls planningNotes when missing, not an object, or every field clamps away to empty', () => {
    expect(clampExtraction({}).planningNotes).toBeNull()
    expect(clampExtraction({ planningNotes: 'nope' as unknown as object }).planningNotes).toBeNull()
    expect(clampExtraction({ planningNotes: [] as unknown as object }).planningNotes).toBeNull()
    expect(
      clampExtraction({ planningNotes: { monumentProtection: '  ', landParcels: [] } }).planningNotes,
    ).toBeNull()
  })

  it('clamps planningNotes scalar fields and landParcels entries', () => {
    const r = clampExtraction({
      planningNotes: {
        monumentProtection: '  kein Denkmalschutz gemäß Denkmalliste  ',
        contamination: 'keine Hinweise auf Altlasten bekannt',
        developmentPlan: 'im Geltungsbereich des Bebauungsplanes XV-37 d gelegen',
        landConsolidation: null,
        developmentCharges: null,
        redevelopmentArea: null,
        conservationArea: null,
        landParcels: [
          { label: 'Teilfläche A', areaSqm: 1460, use: 'gewerbliche Baufläche' },
          { label: '', areaSqm: 500, use: 'skipped: no label' },
          { label: 'Teilfläche B', areaSqm: 527, use: 'öffentliche Verkehrsfläche' },
        ],
      },
    })
    expect(r.planningNotes).not.toBeNull()
    expect(r.planningNotes!.monumentProtection).toBe('kein Denkmalschutz gemäß Denkmalliste')
    expect(r.planningNotes!.contamination).toBe('keine Hinweise auf Altlasten bekannt')
    expect(r.planningNotes!.landConsolidation).toBeNull()
    expect(r.planningNotes!.landParcels).toEqual([
      { label: 'Teilfläche A', areaSqm: 1460, use: 'gewerbliche Baufläche' },
      { label: 'Teilfläche B', areaSqm: 527, use: 'öffentliche Verkehrsfläche' },
    ])
  })

  it('defaults photoCuration to an empty array when missing or malformed', () => {
    expect(clampExtraction({}).photoCuration).toEqual([])
    expect(clampExtraction({ photos: 'nope' as unknown as object }).photoCuration).toEqual([])
  })

  it('clamps photo curation entries: keeps valid ones, trims caption, falls back category/isPropertyPhoto', () => {
    const r = clampExtraction({
      photos: [
        { photoIndex: 0, category: 'aussen', caption: '  Frontansicht  ', isPropertyPhoto: true },
        { photoIndex: 1, category: 'lageplan', caption: null, isPropertyPhoto: false },
        { photoIndex: 2, category: 'unknown-category', caption: 'x'.repeat(300), isPropertyPhoto: 'yes' },
      ],
    })
    expect(r.photoCuration).toEqual([
      { photoIndex: 0, category: 'aussen', caption: 'Frontansicht', isPropertyPhoto: true },
      { photoIndex: 1, category: 'lageplan', caption: null, isPropertyPhoto: false },
      { photoIndex: 2, category: 'sonstiges', caption: 'x'.repeat(200), isPropertyPhoto: true },
    ])
  })

  it('drops photo curation entries with a missing or negative photoIndex', () => {
    expect(
      clampExtraction({
        photos: [
          { category: 'aussen', caption: null, isPropertyPhoto: true },
          { photoIndex: -1, category: 'aussen', caption: null, isPropertyPhoto: true },
          { photoIndex: 1.5, category: 'aussen', caption: null, isPropertyPhoto: true },
        ],
      }).photoCuration,
    ).toEqual([])
  })
})

describe('buildParts', () => {
  it('combines title/description/pdfText into a single text part', () => {
    const parts = buildParts({
      title: 'Einfamilienhaus',
      description: 'Schöne Lage.',
      pdfText: 'Wohnfläche: 140 m²',
    })
    expect(parts).toEqual([
      {
        type: 'text',
        text: 'Objektbezeichnung: Einfamilienhaus\n\nBeschreibung:\nSchöne Lage.\n\nAuszug aus Gutachten/Exposé (PDF):\nWohnfläche: 140 m²',
      },
    ])
  })

  it('returns no parts for empty input', () => {
    expect(buildParts({ title: null, description: null })).toEqual([])
  })

  it('appends one image part per page in pdfPageImages, in order', () => {
    const parts = buildParts({ title: 'Haus', description: null, pdfPageImages: ['aaa', 'bbb'] })
    expect(parts).toEqual([
      { type: 'text', text: 'Objektbezeichnung: Haus\n\nDas Gutachten/Exposé liegt als eingescanntes Bild vor (siehe angehängte Bilder) — lies die Eckdaten daraus ab.' },
      { type: 'image', mimeType: 'image/jpeg', data: 'aaa' },
      { type: 'image', mimeType: 'image/jpeg', data: 'bbb' },
    ])
  })

  it('prefers a document part over pdfText/pdfPageImages when pdfBytes is set', () => {
    const parts = buildParts({
      title: 'Haus',
      description: null,
      pdfText: 'sollte ignoriert werden',
      pdfPageImages: ['ignored-too'],
      pdfBytes: 'base64pdfbytes',
    })
    expect(parts).toEqual([
      { type: 'text', text: 'Objektbezeichnung: Haus' },
      { type: 'document', mimeType: 'application/pdf', data: 'base64pdfbytes' },
    ])
  })

  it('includes every labeled native PDF document', () => {
    const parts = buildParts({
      title: 'Haus',
      description: null,
      pdfDocuments: [
        { label: 'Gutachten', data: 'appraisal' },
        { label: 'Bekanntmachung', data: 'notice' },
      ],
    })
    expect(parts).toEqual([
      { type: 'text', text: 'Objektbezeichnung: Haus' },
      { type: 'text', text: 'Dokument: Gutachten' },
      { type: 'document', mimeType: 'application/pdf', data: 'appraisal' },
      { type: 'text', text: 'Dokument: Bekanntmachung' },
      { type: 'document', mimeType: 'application/pdf', data: 'notice' },
    ])
  })

  it('interleaves an index-labeled text part before each candidate image', () => {
    const parts = buildParts({
      title: 'Haus',
      description: null,
      candidateImages: [
        { label: 'Seite 3, Bild 1', mimeType: 'image/jpeg', data: 'aaa' },
        { label: 'Seite 4, Bild 1', mimeType: 'image/png', data: 'bbb' },
      ],
    })
    expect(parts).toEqual([
      {
        type: 'text',
        text:
          'Objektbezeichnung: Haus\n\nEs folgen 2 Kandidatenbilder aus dem Dokument, jeweils mit ' +
          'vorangestelltem "Bild N:"-Label. Kuratiere jedes Bild im photos-Array (siehe Schema).',
      },
      { type: 'text', text: 'Bild 0: Seite 3, Bild 1' },
      { type: 'image', mimeType: 'image/jpeg', data: 'aaa' },
      { type: 'text', text: 'Bild 1: Seite 4, Bild 1' },
      { type: 'image', mimeType: 'image/png', data: 'bbb' },
    ])
  })

  it('places candidateImages after pdfPageImages when both are present', () => {
    const parts = buildParts({
      title: null,
      description: null,
      pdfPageImages: ['scan-page'],
      candidateImages: [{ label: 'Foto 1', mimeType: 'image/jpeg', data: 'photo' }],
    })
    expect(parts).toEqual([
      {
        type: 'text',
        text:
          'Das Gutachten/Exposé liegt als eingescanntes Bild vor (siehe angehängte Bilder) — lies die Eckdaten daraus ab.\n\n' +
          'Es folgen 1 Kandidatenbilder aus dem Dokument, jeweils mit vorangestelltem "Bild N:"-Label. ' +
          'Kuratiere jedes Bild im photos-Array (siehe Schema).',
      },
      { type: 'image', mimeType: 'image/jpeg', data: 'scan-page' },
      { type: 'text', text: 'Bild 0: Foto 1' },
      { type: 'image', mimeType: 'image/jpeg', data: 'photo' },
    ])
  })
})

describe('resolveLlmConfig', () => {
  it('returns null when unconfigured (no baseUrl)', () => {
    expect(resolveLlmConfig(undefined)).toBeNull()
    expect(resolveLlmConfig({})).toBeNull()
  })

  it('defaults to the openai-compatible provider and its default model', () => {
    expect(resolveLlmConfig({ baseUrl: 'https://api.example' })).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://api.example',
      apiKey: undefined,
      model: 'claude-haiku-4-5',
      maxTokens: undefined,
    })
  })

  it('picks the gemini-native default model when the provider is gemini-native and no model is set', () => {
    expect(resolveLlmConfig({ provider: 'gemini-native', baseUrl: 'https://gemini.example', apiKey: 'k' })).toEqual({
      provider: 'gemini-native',
      baseUrl: 'https://gemini.example',
      apiKey: 'k',
      model: 'gemini-flash-latest',
      maxTokens: undefined,
    })
  })

  it('passes through an explicit model and applies the maxTokens override', () => {
    expect(
      resolveLlmConfig(
        { provider: 'claude-proxy', baseUrl: 'https://proxy.example', model: 'claude-haiku-4-5' },
        { maxTokens: 1024 },
      ),
    ).toEqual({
      provider: 'claude-proxy',
      baseUrl: 'https://proxy.example',
      apiKey: undefined,
      model: 'claude-haiku-4-5',
      maxTokens: 1024,
    })
  })

  it('treats an unknown provider string as openai-compatible', () => {
    expect(resolveLlmConfig({ provider: 'bogus', baseUrl: 'https://api.example' })?.provider).toBe('openai-compatible')
  })
})
