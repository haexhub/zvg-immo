import { describe, expect, it } from 'vitest'
import { extractFact, parseStorlek, cleanCategory, parseSekAmount } from './text'

describe('extractFact', () => {
  it('extracts a sidebar fact (h3)', () => {
    const html =
      '<h3 class="faktaxxhogerpuffrubrikxxh4x" id="h-Adress">Adress</h3><p class="normal">Köpmangatan 7, Vistträsk</p>'
    expect(extractFact(html, 'Adress')).toBe('Köpmangatan 7, Vistträsk')
  })

  it('extracts a body fact (h2)', () => {
    const html =
      '<h2 class="h2rubrik" id="h-Upplatelseform">Upplåtelseform</h2><p class="normal">Äganderätt.</p>'
    expect(extractFact(html, 'Upplatelseform')).toBe('Äganderätt.')
  })

  it('stops at <br> inside the fact paragraph', () => {
    const html =
      '<h3 id="h-Storlek">Storlek</h3><p class="normal">6 rum, 175 kvm<br>6 rum och kök</p>'
    expect(extractFact(html, 'Storlek')).toBe('6 rum, 175 kvm')
  })

  it('returns null when the heading has no following paragraph', () => {
    const html =
      '<h2 class="h2rubrik" id="h-Beskrivning">Beskrivning</h2><h2 class="h2rubrik" id="h-Tomtbeskrivning">Tomtbeskrivning</h2>'
    expect(extractFact(html, 'Beskrivning')).toBeNull()
  })
})

describe('parseStorlek', () => {
  it('parses rooms and living area from "6 rum, 175 kvm"', () => {
    expect(parseStorlek('6 rum, 175 kvm')).toEqual({ rooms: 6, livingAreaSqm: 175 })
  })

  it('handles missing parts', () => {
    expect(parseStorlek('175 kvm')).toEqual({ rooms: null, livingAreaSqm: 175 })
    expect(parseStorlek('3 rum')).toEqual({ rooms: 3, livingAreaSqm: null })
    expect(parseStorlek(null)).toEqual({ rooms: null, livingAreaSqm: null })
    expect(parseStorlek('okänd')).toEqual({ rooms: null, livingAreaSqm: null })
  })
})

describe('cleanCategory', () => {
  it('strips the numeric tax code and trailing period', () => {
    expect(cleanCategory('Småhusenhet, bebyggd (220).')).toBe('Småhusenhet, bebyggd')
    expect(cleanCategory('Äganderätt.')).toBe('Äganderätt')
  })

  it('returns null for empty input', () => {
    expect(cleanCategory(null)).toBeNull()
    expect(cleanCategory('')).toBeNull()
  })
})

describe('parseSekAmount', () => {
  it('parses "450000:-" and spaced thousands', () => {
    expect(parseSekAmount('450000:-')).toBe(450000)
    expect(parseSekAmount('1 200 000:-')).toBe(1200000)
  })
})
