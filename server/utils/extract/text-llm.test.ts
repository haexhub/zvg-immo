import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmConfig } from './llm'
import { callPlaceNameTranslationLlm, callSummaryLlm, callTranslationLlm } from './text-llm'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('callSummaryLlm', () => {
  const openAiConfig: LlmConfig = { provider: 'openai-compatible', baseUrl: 'https://api.example', model: 'gpt' }
  const geminiConfig: LlmConfig = {
    provider: 'gemini-native',
    baseUrl: 'https://gemini.example',
    apiKey: 'k',
    model: 'gemini-flash-latest',
  }

  it('extracts the summary field via the openai-compatible provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ summary: '**Objekt** Hallo' }) } }],
    })
    vi.stubGlobal('$fetch', fetchMock)
    await expect(callSummaryLlm('sys', 'user text', openAiConfig)).resolves.toBe('**Objekt** Hallo')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  // Regression test for the bug this file fixes: summary/translation used to
  // hardcode Anthropic's /v1/messages format regardless of which provider
  // runtimeConfig.extractLlm actually selected, so a Gemini-configured
  // deployment 404'd. This confirms the wire format now follows the config.
  it('extracts the summary field via the gemini-native provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'Zusammenfassung' }) }] } }],
    })
    vi.stubGlobal('$fetch', fetchMock)
    await expect(callSummaryLlm('sys', 'user text', geminiConfig)).resolves.toBe('Zusammenfassung')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gemini.example/v1beta/models/gemini-flash-latest:generateContent',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('returns null when the provider response has no summary field', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ choices: [{ message: { content: '{}' } }] }))
    await expect(callSummaryLlm('sys', 'user text', openAiConfig)).resolves.toBeNull()
  })

  it('surfaces request failure', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('boom')))
    await expect(callSummaryLlm('sys', 'user text', openAiConfig)).rejects.toMatchObject({ name: 'LlmProviderError' })
  })
})

describe('callTranslationLlm', () => {
  const config: LlmConfig = { provider: 'openai-compatible', baseUrl: 'https://api.example', model: 'gpt' }

  function stubResponse(payload: Record<string, unknown>) {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(payload) } }] }))
  }

  it('returns the translated title, address and description', async () => {
    stubResponse({
      title: 'Haus',
      address: 'Hauptstraße 5, Musterstadt',
      description: 'Schöne Beschreibung',
      documentSummary: 'Ausführliche Dokument-Zusammenfassung',
      extractionTexts: null,
    })
    await expect(
      callTranslationLlm('sys', 'user text', 'House', 'Main Street 5, Sampletown', 'Nice description', 'Detailed document summary', null, config),
    ).resolves.toEqual({
      title: 'Haus',
      address: 'Hauptstraße 5, Musterstadt',
      description: 'Schöne Beschreibung',
      documentSummary: 'Ausführliche Dokument-Zusammenfassung',
      extractionTexts: null,
    })
  })

  it('keeps a null field null when the source was null', async () => {
    stubResponse({ title: 'Haus', address: null, description: null, documentSummary: null, extractionTexts: null })
    await expect(callTranslationLlm('sys', 'user text', 'House', null, null, null, null, config)).resolves.toEqual({
      title: 'Haus',
      address: null,
      description: null,
      documentSummary: null,
      extractionTexts: null,
    })
  })

  it('signals failure when the source had an address but the model returned an empty one', async () => {
    stubResponse({ title: null, address: '', description: null, documentSummary: null, extractionTexts: null })
    await expect(callTranslationLlm('sys', 'user text', null, 'Main Street 5', null, null, null, config)).resolves.toBeNull()
  })

  it('returns translated structured extraction text', async () => {
    const source = {
      biddingNotes: null,
      renovationNotes: 'Visst underhållsbehov finna',
      floor: null,
      heating: 'Fjärrvärme',
      insights: {
        defects: ['Äldre fastighet med äldre ytlager'],
        encumbrances: ['Utmätning jämte ränta och kostnader'],
        construction: 'Torpargrund, trästomme',
        locationCharacter: 'Beläget inom planlagt område',
        summary: null,
      },
      planningNotes: {
        monumentProtection: 'Ingen information',
        contamination: null,
        developmentPlan: 'Beläget inom planlagt område',
        landConsolidation: null,
        developmentCharges: null,
        redevelopmentArea: null,
        conservationArea: null,
        landParcels: [{ label: 'Delområde A', use: 'Villatomt' }],
      },
    }
    stubResponse({
      title: null,
      description: null,
      documentSummary: null,
      extractionTexts: {
        biddingNotes: null,
        renovationNotes: 'Gewisser Instandhaltungsbedarf vorhanden',
        floor: null,
        heating: 'Fernwärme',
        insights: {
          defects: ['Ältere Immobilie mit älteren Oberflächen'],
          encumbrances: ['Pfändung zuzüglich Zinsen und Kosten'],
          construction: 'Kriechkellerfundament, Holztragwerk',
          locationCharacter: 'Innerhalb eines beplanten Gebiets gelegen',
          summary: null,
        },
        planningNotes: {
          monumentProtection: 'Keine Informationen',
          contamination: null,
          developmentPlan: 'Innerhalb eines beplanten Gebiets gelegen',
          landConsolidation: null,
          developmentCharges: null,
          redevelopmentArea: null,
          conservationArea: null,
          landParcels: [{ label: 'Teilbereich A', use: 'Villengrundstück' }],
        },
      },
    })

    await expect(callTranslationLlm('sys', 'user text', null, null, null, null, source, config)).resolves.toMatchObject({
      extractionTexts: {
        renovationNotes: 'Gewisser Instandhaltungsbedarf vorhanden',
        heating: 'Fernwärme',
        insights: {
          defects: ['Ältere Immobilie mit älteren Oberflächen'],
          construction: 'Kriechkellerfundament, Holztragwerk',
        },
        planningNotes: {
          monumentProtection: 'Keine Informationen',
          landParcels: [{ label: 'Teilbereich A', use: 'Villengrundstück' }],
        },
      },
    })
  })

  it('signals failure when the source had a title but the model returned an empty one', async () => {
    stubResponse({ title: '', address: null, description: 'x', documentSummary: null, extractionTexts: null })
    await expect(callTranslationLlm('sys', 'user text', 'House', null, 'x', null, null, config)).resolves.toBeNull()
  })

  it('signals failure when a source document summary was not translated', async () => {
    stubResponse({ title: null, address: null, description: null, documentSummary: '', extractionTexts: null })
    await expect(callTranslationLlm('sys', 'user text', null, null, null, 'Document', null, config)).resolves.toBeNull()
  })

  it('signals failure when structured array lengths change', async () => {
    stubResponse({
      title: null,
      description: null,
      documentSummary: null,
      extractionTexts: {
        biddingNotes: null,
        renovationNotes: null,
        floor: null,
        heating: null,
        insights: {
          defects: [],
          encumbrances: [],
          construction: null,
          locationCharacter: null,
          summary: null,
        },
        planningNotes: null,
      },
    })
    await expect(callTranslationLlm('sys', 'user text', null, null, null, null, {
      biddingNotes: null,
      renovationNotes: null,
      floor: null,
      heating: null,
      insights: {
        defects: ['one'],
        encumbrances: [],
        construction: null,
        locationCharacter: null,
        summary: null,
      },
      planningNotes: null,
    }, config)).resolves.toBeNull()
  })

  it('accepts a structured result even when some strings are unchanged or mixed-language', async () => {
    stubResponse({
      title: null,
      description: null,
      documentSummary: null,
      extractionTexts: {
        biddingNotes: null,
        renovationNotes: null,
        floor: null,
        heating: null,
        insights: {
          defects: [],
          encumbrances: [],
          construction: null,
          locationCharacter: null,
          summary: null,
        },
        planningNotes: {
          monumentProtection: null,
          contamination: 'Värderingsobjektet är inte registrerat i Länsstyrelsens register.',
          developmentPlan: 'Värderingsobjektet är beläget inom planlagt område.',
          landConsolidation: null,
          developmentCharges: null,
          redevelopmentArea: null,
          conservationArea: null,
          landParcels: [],
        },
      },
    })
    await expect(callTranslationLlm('sys', 'user text', null, null, null, null, {
      biddingNotes: null,
      renovationNotes: null,
      floor: null,
      heating: null,
      insights: {
        defects: [],
        encumbrances: [],
        construction: null,
        locationCharacter: null,
        summary: null,
      },
      planningNotes: {
        monumentProtection: null,
        contamination: 'Värderingsobjektet är inte registrerat i Länsstyrelsens register.',
        developmentPlan: 'Värderingsobjektet är beläget inom planlagt område.',
        landConsolidation: null,
        developmentCharges: null,
        redevelopmentArea: null,
        conservationArea: null,
        landParcels: [],
      },
    }, config)).resolves.toMatchObject({
      extractionTexts: {
        planningNotes: {
          contamination: 'Värderingsobjektet är inte registrerat i Länsstyrelsens register.',
          developmentPlan: 'Värderingsobjektet är beläget inom planlagt område.',
        },
      },
    })
  })

  it('allows unchanged parcel labels because they are identifiers', async () => {
    stubResponse({
      title: null,
      description: null,
      documentSummary: null,
      extractionTexts: {
        biddingNotes: null,
        renovationNotes: null,
        floor: null,
        heating: null,
        insights: null,
        planningNotes: {
          monumentProtection: null,
          contamination: null,
          developmentPlan: null,
          landConsolidation: null,
          developmentCharges: null,
          redevelopmentArea: null,
          conservationArea: null,
          landParcels: [{ label: 'Ljusdal Nor 1:5', use: 'Residential unit, built' }],
        },
      },
    })
    await expect(callTranslationLlm('sys', 'user text', null, null, null, null, {
      biddingNotes: null,
      renovationNotes: null,
      floor: null,
      heating: null,
      insights: null,
      planningNotes: {
        monumentProtection: null,
        contamination: null,
        developmentPlan: null,
        landConsolidation: null,
        developmentCharges: null,
        redevelopmentArea: null,
        conservationArea: null,
        landParcels: [{ label: 'Ljusdal Nor 1:5', use: 'Småhusenhet, bebyggd' }],
      },
    }, config)).resolves.toMatchObject({
      extractionTexts: {
        planningNotes: {
          landParcels: [{ label: 'Ljusdal Nor 1:5', use: 'Residential unit, built' }],
        },
      },
    })
  })

  it('surfaces request failure', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('boom')))
    await expect(callTranslationLlm('sys', 'user text', 'House', null, 'desc', null, null, config)).rejects.toMatchObject({ name: 'LlmProviderError' })
  })
})

describe('callPlaceNameTranslationLlm', () => {
  const config: LlmConfig = { provider: 'openai-compatible', baseUrl: 'https://api.example', model: 'gpt' }

  it('returns one translated name per input, in order', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ names: ['Burgas', 'Ravna'] }) } }],
    }))
    await expect(callPlaceNameTranslationLlm(['Бургас', 'Равна'], 'English', config)).resolves.toEqual(['Burgas', 'Ravna'])
  })

  it('returns null when the model drops or merges entries (length mismatch)', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ names: ['Burgas'] }) } }],
    }))
    await expect(callPlaceNameTranslationLlm(['Бургас', 'Равна'], 'English', config)).resolves.toBeNull()
  })

  it('returns null when a name comes back empty', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ names: ['Burgas', ''] }) } }],
    }))
    await expect(callPlaceNameTranslationLlm(['Бургас', 'Равна'], 'English', config)).resolves.toBeNull()
  })
})
