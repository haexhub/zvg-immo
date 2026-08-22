import { describe, expect, it } from 'vitest'
import type { AuctionExtraction } from '~/types/auction'
import type { ClampedExtraction } from './llm'
import { dropStaleRuleChecks, falsifiedRuleFields, mergeLlmResult, type MergeInputFields } from './merge-llm-result'

const AT = '2026-07-23T00:00:00.000Z'

function baseFields(overrides: Partial<MergeInputFields> = {}): MergeInputFields {
  return {
    propertyType: null,
    landAreaSqm: null,
    livingAreaSqm: null,
    rooms: null,
    units: null,
    securityDeposit: null,
    ...overrides,
  }
}

function llmResult(overrides: Partial<ClampedExtraction> = {}): ClampedExtraction {
  return {
    propertyType: 'einfamilienhaus',
    landAreaSqm: 500,
    livingAreaSqm: 120,
    rooms: 4,
    bedrooms: 3,
    bathrooms: 1,
    floor: 'EG',
    bathroomHasTub: true,
    bathroomHasShower: true,
    heating: 'Gaszentralheizung',
    units: 1,
    securityDeposit: null,
    ruleCheck: null,
    biddingNotes: null,
    condition: 'neuwertig',
    features: ['balkon'],
    yearBuilt: 1990,
    lastRenovationYear: null,
    renovationNotes: null,
    insights: null,
    planningNotes: null,
    documentSummary: null,
    photoCuration: [],
    marketValueEur: null,
    marketValueText: null,
    ...overrides,
  }
}

describe('mergeLlmResult', () => {
  it('lets the LLM fill propertyType/sizes when rules found nothing', () => {
    const entry = mergeLlmResult(undefined, baseFields(), llmResult(), AT, undefined)

    expect(entry.source).toBe('llm')
    expect(entry.propertyType).toBe('einfamilienhaus')
    expect(entry.landAreaSqm).toBe(500)
    expect(entry.confidence).toBe('high')
  })

  it('keeps source rules and does not overwrite propertyType/sizes when the LLM does not falsify them', () => {
    const fields = baseFields({ propertyType: 'eigentumswohnung', landAreaSqm: 80, rooms: 2, units: 1 })
    const entry = mergeLlmResult(undefined, fields, llmResult({ propertyType: 'einfamilienhaus', landAreaSqm: 999 }), AT, undefined)

    expect(entry.source).toBe('rules')
    expect(entry.propertyType).toBe('eigentumswohnung')
    expect(entry.landAreaSqm).toBe(80)
  })

  it('always applies biddingNotes from the LLM, even when propertyType/sizes stay on rules values', () => {
    const fields = baseFields({ propertyType: 'eigentumswohnung', landAreaSqm: 80, rooms: 2, units: 1 })
    const entry = mergeLlmResult(undefined, fields, llmResult({ biddingNotes: 'Abweichende Zahlungsfrist' }), AT, undefined)

    expect(entry.source).toBe('rules')
    expect(entry.biddingNotes).toBe('Abweichende Zahlungsfrist')
  })

  it('lets the LLM fill missing area gaps even when the type is already resolved', () => {
    const fields = baseFields({ propertyType: 'einfamilienhaus', livingAreaSqm: 180, rooms: 5, units: 1 })
    const entry = mergeLlmResult(undefined, fields, llmResult({ landAreaSqm: 1316 }), AT, undefined)

    expect(entry.source).toBe('rules')
    expect(entry.livingAreaSqm).toBe(180)
    expect(entry.landAreaSqm).toBe(1316)
  })

  it('derives missing land area from complete parcel areas across sources', () => {
    const fields = baseFields({ propertyType: 'einfamilienhaus', livingAreaSqm: 180 })
    const entry = mergeLlmResult(
      undefined,
      fields,
      llmResult({
        landAreaSqm: null,
        planningNotes: {
          monumentProtection: null,
          contamination: null,
          developmentPlan: null,
          landConsolidation: null,
          developmentCharges: null,
          redevelopmentArea: null,
          conservationArea: null,
          landParcels: [
            { label: 'Flurstück 743/1', areaSqm: 500, use: 'Wohnbaufläche' },
            { label: 'Flurstück 743/2', areaSqm: 816, use: 'Gartenland' },
          ],
        },
      }),
      AT,
      undefined,
    )

    expect(entry.landAreaSqm).toBe(1316)
  })

  it('does not derive land area from incomplete parcel lists', () => {
    const fields = baseFields({ propertyType: 'einfamilienhaus', livingAreaSqm: 180 })
    const entry = mergeLlmResult(
      undefined,
      fields,
      llmResult({
        landAreaSqm: null,
        planningNotes: {
          monumentProtection: null,
          contamination: null,
          developmentPlan: null,
          landConsolidation: null,
          developmentCharges: null,
          redevelopmentArea: null,
          conservationArea: null,
          landParcels: [
            { label: '743/1', areaSqm: 500, use: null },
            { label: '743/2', areaSqm: null, use: null },
          ],
        },
      }),
      AT,
      undefined,
    )

    expect(entry.landAreaSqm).toBeNull()
  })

  it('lets a complete parcel sum correct a smaller extracted land area', () => {
    const fields = baseFields({ propertyType: 'einfamilienhaus', landAreaSqm: 563, livingAreaSqm: 142 })
    const entry = mergeLlmResult(
      undefined,
      fields,
      llmResult({
        landAreaSqm: null,
        planningNotes: {
          monumentProtection: null,
          contamination: null,
          developmentPlan: null,
          landConsolidation: null,
          developmentCharges: null,
          redevelopmentArea: null,
          conservationArea: null,
          landParcels: [
            { label: 'Sunne Ivarsbjörke 1:492', areaSqm: 15337, use: 'Lantbruksenhet' },
            { label: 'Sunne Ivarsbjörke 1:491', areaSqm: 15270, use: 'Småhusenhet' },
          ],
        },
      }),
      AT,
      undefined,
    )

    expect(entry.landAreaSqm).toBe(30607)
  })

  it('always applies LLM-only fields (condition/features/yearBuilt/...)', () => {
    const fields = baseFields({ propertyType: 'eigentumswohnung', landAreaSqm: 80 })
    const entry = mergeLlmResult(undefined, fields, llmResult({ condition: 'sanierungsbeduerftig' }), AT, undefined)

    expect(entry.condition).toBe('sanierungsbeduerftig')
    expect(entry.features).toEqual(['balkon'])
    expect(entry.yearBuilt).toBe(1990)
    expect(entry.bedrooms).toBe(3)
    expect(entry.bathrooms).toBe(1)
    expect(entry.floor).toBe('EG')
    expect(entry.bathroomHasTub).toBe(true)
    expect(entry.bathroomHasShower).toBe(true)
    expect(entry.heating).toBe('Gaszentralheizung')
  })

  it('does not fill an already-set field from the LLM (rules/source values win)', () => {
    const fields = baseFields({ rooms: 3 })
    const entry = mergeLlmResult(undefined, fields, llmResult({ rooms: 7 }), AT, undefined)

    expect(entry.rooms).toBe(3)
  })

  it('stamps llmAnalyzedAt on successful LLM calls, even when source stays rules', () => {
    const fields = baseFields({ propertyType: 'eigentumswohnung', landAreaSqm: 80, rooms: 2, units: 1 })
    const entry = mergeLlmResult(undefined, fields, llmResult(), AT, undefined)

    expect(entry.source).toBe('rules')
    expect(entry.llmAnalyzedAt).toBe(AT)
  })

  it('does not stamp llmAnalyzedAt when the LLM call failed', () => {
    const entry = mergeLlmResult(undefined, baseFields(), null, AT, undefined)

    expect(entry.llmAnalyzedAt).toBeUndefined()
  })

  it('keeps a prior biddingNotes when the LLM call failed', () => {
    const entry = mergeLlmResult(undefined, baseFields({ biddingNotes: 'Abweichende Zahlungsfrist' }), null, AT, undefined)

    expect(entry.biddingNotes).toBe('Abweichende Zahlungsfrist')
  })

  it('reports low confidence when neither type nor area could be resolved', () => {
    const entry = mergeLlmResult(undefined, baseFields(), llmResult({ propertyType: null, landAreaSqm: null, livingAreaSqm: null }), AT, undefined)
    expect(entry.confidence).toBe('low')
  })

  it('passes photos through unchanged', () => {
    const photos = [{ file: 'a.jpg', category: 'aussen' as const, caption: null, isPropertyPhoto: true }]
    const entry = mergeLlmResult(undefined, baseFields(), llmResult(), AT, photos)
    expect(entry.photos).toBe(photos)
  })

  it('stamps the given timestamp', () => {
    const entry = mergeLlmResult(undefined, baseFields(), llmResult(), AT, undefined)
    expect(entry.at).toBe(AT)
  })

  describe('ruleCheck verification', () => {
    it('lets the LLM override propertyType when ruleCheck falsifies it', () => {
      // The zvbawu/1328571 shape: rules picked "mehrfamilienhaus" off a
      // "... in einem Mehrfamilienhaus" mention describing the surrounding
      // building, not the auctioned unit.
      const fields = baseFields({ propertyType: 'mehrfamilienhaus' })
      const entry = mergeLlmResult(
        undefined,
        fields,
        llmResult({ propertyType: 'eigentumswohnung', ruleCheck: { propertyType: false, rooms: null, units: null, securityDeposit: null } }),
        AT,
        undefined,
      )

      expect(entry.propertyType).toBe('eigentumswohnung')
      expect(entry.source).toBe('llm')
    })

    it('keeps the rules propertyType when ruleCheck confirms it, even if the LLM guessed differently', () => {
      const fields = baseFields({ propertyType: 'eigentumswohnung', rooms: 2, units: 1 })
      const entry = mergeLlmResult(
        undefined,
        fields,
        llmResult({ propertyType: 'mehrfamilienhaus', ruleCheck: { propertyType: true, rooms: null, units: null, securityDeposit: null } }),
        AT,
        undefined,
      )

      expect(entry.propertyType).toBe('eigentumswohnung')
      expect(entry.source).toBe('rules')
    })

    it('keeps the rules propertyType when no ruleCheck hint was given at all', () => {
      const fields = baseFields({ propertyType: 'eigentumswohnung', rooms: 2, units: 1 })
      const entry = mergeLlmResult(undefined, fields, llmResult({ propertyType: 'mehrfamilienhaus', ruleCheck: null }), AT, undefined)

      expect(entry.propertyType).toBe('eigentumswohnung')
      expect(entry.source).toBe('rules')
    })

    it('lets the LLM override rooms/units/securityDeposit when ruleCheck falsifies them', () => {
      const fields = baseFields({ propertyType: 'eigentumswohnung', rooms: 2, units: 5, securityDeposit: 1000 })
      const entry = mergeLlmResult(
        undefined,
        fields,
        llmResult({
          rooms: 3,
          units: 1,
          securityDeposit: 2500,
          ruleCheck: { propertyType: null, rooms: false, units: false, securityDeposit: false },
        }),
        AT,
        undefined,
      )

      expect(entry.rooms).toBe(3)
      expect(entry.units).toBe(1)
      expect(entry.securityDeposit).toBe(2500)
      expect(entry.source).toBe('llm')
    })
  })
})

describe('falsifiedRuleFields', () => {
  it('lists only fields where a real rules value was refuted', () => {
    const fields = baseFields({ propertyType: 'mehrfamilienhaus', rooms: 2, units: null })
    const llm = llmResult({ ruleCheck: { propertyType: false, rooms: true, units: false, securityDeposit: false } })

    // units/securityDeposit had no rules value to refute in the first place.
    expect(falsifiedRuleFields(fields, llm)).toEqual(['propertyType'])
  })

  it("ignores a refuted 'sonstiges', which the LLM overrides anyway", () => {
    const fields = baseFields({ propertyType: 'sonstiges' })
    const llm = llmResult({ ruleCheck: { propertyType: false, rooms: null, units: null, securityDeposit: null } })

    expect(falsifiedRuleFields(fields, llm)).toEqual([])
  })

  it('is empty without a ruleCheck or a result at all', () => {
    const fields = baseFields({ propertyType: 'mehrfamilienhaus', rooms: 2 })
    expect(falsifiedRuleFields(fields, llmResult({ ruleCheck: null }))).toEqual([])
    expect(falsifiedRuleFields(fields, null)).toEqual([])
  })

  it('agrees with what mergeLlmResult actually did', () => {
    const fields = baseFields({ propertyType: 'mehrfamilienhaus', rooms: 2, units: 5, securityDeposit: 1000 })
    const llm = llmResult({
      propertyType: 'eigentumswohnung',
      rooms: 3,
      units: 1,
      securityDeposit: 2500,
      ruleCheck: { propertyType: false, rooms: true, units: false, securityDeposit: null },
    })
    const entry = mergeLlmResult(undefined, fields, llm, AT, undefined)

    // Every reported field must carry the LLM's value, every unreported one
    // the rules value — otherwise the counter and the merge have drifted.
    expect(falsifiedRuleFields(fields, llm)).toEqual(['propertyType', 'units'])
    expect(entry.propertyType).toBe('eigentumswohnung')
    expect(entry.units).toBe(1)
    expect(entry.rooms).toBe(2)
    expect(entry.securityDeposit).toBe(1000)
  })
})

describe('dropStaleRuleChecks', () => {
  const HINT = { propertyType: 'mehrfamilienhaus', rooms: 2, units: null, securityDeposit: null }
  const RULE_CHECK = { propertyType: false, rooms: false, units: null, securityDeposit: null }

  it('keeps verdicts whose value is unchanged since the hint was sent', () => {
    const fields = baseFields({ propertyType: 'mehrfamilienhaus', rooms: 2 })

    expect(dropStaleRuleChecks(RULE_CHECK, HINT, fields)).toEqual(RULE_CHECK)
  })

  it('drops the verdict for a field whose rules value changed in the meantime', () => {
    // A re-crawl between batch submit and poll turned the title into a
    // "3-Zimmerwohnung": the "rooms is wrong" verdict was about the old 2.
    const fields = baseFields({ propertyType: 'mehrfamilienhaus', rooms: 3 })

    expect(dropStaleRuleChecks(RULE_CHECK, HINT, fields)).toEqual({
      propertyType: false,
      rooms: null,
      units: null,
      securityDeposit: null,
    })
  })

  it('drops every verdict when no hint was recorded', () => {
    const fields = baseFields({ propertyType: 'mehrfamilienhaus', rooms: 2 })

    expect(dropStaleRuleChecks(RULE_CHECK, null, fields)).toBeNull()
  })

  it("treats a rules value that decayed to 'sonstiges' as changed", () => {
    const fields = baseFields({ propertyType: 'sonstiges', rooms: 2 })

    expect(dropStaleRuleChecks(RULE_CHECK, HINT, fields)?.propertyType).toBeNull()
  })

  it('returns null once nothing survives', () => {
    const fields = baseFields({ propertyType: 'einfamilienhaus', rooms: 9 })

    expect(dropStaleRuleChecks(RULE_CHECK, HINT, fields)).toBeNull()
  })
})
