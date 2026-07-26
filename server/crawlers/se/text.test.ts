import { describe, expect, it } from 'vitest'
import {
  extractBody,
  extractFact,
  parseStorlek,
  cleanCategory,
  parseSekAmount,
  cleanKronofogdenAddress,
  extractShowingAddress,
  stripHtml,
} from './text'

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

describe('cleanKronofogdenAddress', () => {
  it('removes missing-address prefixes and normalises Swedish postcodes', () => {
    expect(cleanKronofogdenAddress('adress saknas/Norrlimstavägen 33, 87231, Kramfors'))
      .toBe('Norrlimstavägen 33, 872 31 Kramfors')
  })
})

describe('extractShowingAddress', () => {
  it('reads the embedded booking widget address', () => {
    const html = `
      <script>
        AppRegistry.registerInitialState('id', {"showingAddress":"Kvarnbyn 76, 93794, Burtr\\u00e4sk"});
      </script>
    `

    expect(extractShowingAddress(html)).toBe('Kvarnbyn 76, 937 94 Burträsk')
  })

  it('returns null when no showing address is embedded', () => {
    expect(extractShowingAddress('<main>No widget</main>')).toBeNull()
  })
})

describe('stripHtml', () => {
  it('drops embedded app scripts instead of exposing their source as text', () => {
    const html = `
      <p class="normal">Objekttext</p>
      <script>AppRegistry.registerInitialState('id', {"showingAddress":"X"});</script>
    `

    expect(stripHtml(html)).toBe('Objekttext')
  })
})

describe('extractBody', () => {
  it('uses Kronofogden ingress/content portlets and ignores booking widget scripts', () => {
    const html = `
      <div id="Mittenspalt"><!-- Mittenspalt --></div>
      <div class="sv-text-portlet">
        <div id="Ingress"><!-- Ingress --></div>
        <div class="sv-text-portlet-content">
          <p class="brodtextxingress">Villa om 170 m².</p>
          <p class="normal">Byggnaden är uppförd utan startbesked.</p>
        </div>
      </div>
      <div class="sv-text-portlet">
        <div id="Innehall"><!-- Innehåll --></div>
        <div class="sv-text-portlet-content">
          <h2 id="h-Beskrivning">Beskrivning</h2>
          <h2 id="h-Tomtbeskrivning">Tomtbeskrivning</h2>
          <p class="normal">Tomt om 1 566 m².</p>
        </div>
      </div>
      <div id="Bokningstjanstvisning">
        <script>AppRegistry.registerApp({applicationId:'auk-visning-app'});</script>
      </div>
    `

    const body = extractBody(html)
    expect(body).toContain('Villa om 170 m².')
    expect(body).toContain('Tomtbeskrivning')
    expect(body).not.toContain('AppRegistry')
    expect(body).not.toContain('auk-visning-app')
  })

  it('falls back to Mittenspalt when targeted portlets are too short', () => {
    const html = `
      <div class="sv-text-portlet">
        <div id="Ingress"><!-- Ingress --></div>
        <div class="sv-text-portlet-content"><p>Short</p></div>
      </div>
      <div id="Mittenspalt">
        <p class="normal">Fallback body text with enough useful content.</p>
      </div>
      <div id="Hogerspalt"></div>
    `

    expect(extractBody(html)).toBe('Fallback body text with enough useful content.')
  })
})
