import { describe, expect, it } from 'vitest'
import { extractLocation, parseBaDate, parseBamPrice, stripHtml } from './text'

describe('parseBaDate', () => {
  it('parses "21.08.2026" into ISO', () => {
    expect(parseBaDate('21.08.2026')).toBe('2026-08-21')
  })

  it('returns null without a date', () => {
    expect(parseBaDate('van ročišta')).toBeNull()
  })
})

describe('parseBamPrice', () => {
  it('parses a labeled amount, returning the native BAM figure', () => {
    expect(parseBamPrice('Ukupna cijena iznosi 150.000,00 KM')).toEqual({
      bam: 150000,
      text: '150.000,00 KM',
    })
  })

  it('allows line breaks between label and amount (live case 149069)', () => {
    const text =
      'v.s.p. 118.794,81 KM , van ročišta, donio je sljedeće:\n' +
      'Vrijednost nekretnina koje su predmet prodaje a\n' +
      'koje su opisane\n' +
      'u tačci 1. ovog zaključka ukupno iznosi 297.418,00 KM.'
    // must pick the labeled value, not the earlier claim amount (v.s.p.)
    expect(parseBamPrice(text)?.text).toBe('297.418,00 KM')
  })

  it('matches inflected label variants (utvrđena/tržišna/početna/procijenjena vrijednost)', () => {
    expect(parseBamPrice('tržišna vrijednost nekretnina utvrđena u iznosu od 71.442,00\nKM')?.text)
      .toBe('71.442,00 KM')
    expect(parseBamPrice('procijenjena vrijednost: 25.000,00 KM')?.text).toBe('25.000,00 KM')
    expect(parseBamPrice('početna cijena iznosi 12.345,00 KM')?.text).toBe('12.345,00 KM')
  })

  it('skips labeled amounts below 1000 KM and moves on', () => {
    const text = 'cijena takse 263,39 KM\nutvrđena vrijednost nekretnine 45.000,00 KM'
    expect(parseBamPrice(text)?.text).toBe('45.000,00 KM')
  })

  it('does not treat a deposit cap ("najviše 10.000,00 KM") as the value (live case 148348)', () => {
    const text =
      'vrijednost iste utvrđena je na temelju nalaza i mišljenja stalnog sudskog vještaka ' +
      'građevinsko-arhitektonske struke od 15.05.2025. god. i to na iznos: 236.800,00 KM.\n' +
      'Osiguranje iznosi 1/10 određene vrijednosti nekretnine s tim što ne ' +
      'može iznositi više od 10.000,00 KM (desethiljadakonvertibilnihmaraka).'
    expect(parseBamPrice(text)?.text).toBe('236.800,00 KM')
  })

  it('falls back to the first amount ≥ 1000 KM without a label', () => {
    expect(parseBamPrice('iznos od 263,39 KM te iznos od 5.540,00 KM')?.text).toBe('5.540,00 KM')
  })

  it('returns null when only small fee amounts are present', () => {
    expect(parseBamPrice('taksa iznosi 263,39 KM')).toBeNull()
  })

  it('parses an amount glued to KM (live case 153964)', () => {
    expect(parseBamPrice('vrijednosti od 714.225,41KM')?.text).toBe('714.225,41 KM')
  })
})

describe('extractLocation', () => {
  it('finds an uppercase cadastral municipality "KO"', () => {
    expect(extractLocation('nekretnine u KO Sarajevo-Centar upisane u zk.')).toBe(
      'Sarajevo-Centar, Bosnien-Herzegowina',
    )
  })

  it('finds lowercase "k.o." variants incl. "k.o ." with stray space', () => {
    expect(extractLocation('upisanih u zk. ulošku broj 908 k.o. Labucka što odgovara')).toBe(
      'Labucka, Bosnien-Herzegowina',
    )
    expect(extractLocation('uvidom u ZK uložak broj 45 k.o . Čipuljić')).toBe(
      'Čipuljić, Bosnien-Herzegowina',
    )
  })

  it('stops the cadastral name at lowercase words and drops the SP prefix', () => {
    expect(extractLocation('posjedovni list broj 682 k.o. Lopare Grad na kojima je izvršenik')).toBe(
      'Lopare Grad, Bosnien-Herzegowina',
    )
    expect(extractLocation('upisana u zk. ul. br. 6045 k.o. SP_Gornji Vakuf.')).toBe(
      'Gornji Vakuf, Bosnien-Herzegowina',
    )
  })

  it('does not match "KO" inside "BRČKO" or the DISTRIKT boilerplate (live case 150403)', () => {
    expect(extractLocation('BRČKO DISTRIKT BOSNE I HERCEGOVINE\nOsnovni sud')).toBeNull()
    expect(extractLocation('BRČKO DISTRIKT BOSNE I HERCEGOVINE, k.o. Brčko 1')).toBe(
      'Brčko, Bosnien-Herzegowina',
    )
  })

  it('finds street addresses via ul./Ulica', () => {
    expect(extractLocation('u ul. Vojvode Radomira Putnika bb')).toBe(
      'Vojvode Radomira Putnika bb, Bosnien-Herzegowina',
    )
  })

  it('finds municipality via općina/opština/grad', () => {
    expect(extractLocation('na području općine Kalesija')).toBe('Kalesija, Bosnien-Herzegowina')
    expect(extractLocation('opština Ugljevik, RS')).toBe('Ugljevik, Bosnien-Herzegowina')
  })

  it('finds postal code + place', () => {
    expect(extractLocation('na adresi 75300 Lukavac')).toBe('75300 Lukavac, Bosnien-Herzegowina')
  })

  it('falls back to the debtor\'s place "izvršenika ... iz <Ort>" (live case 150545)', () => {
    expect(extractLocation('protiv izvršenika Tomić Duška iz Kojčinovca 2 Ulica br.13')).toBe(
      'Kojčinovca, Bosnien-Herzegowina',
    )
  })

  it('falls back to the court seat "sudu u <Ort>" (live case 149174)', () => {
    expect(extractLocation('u 10:30 sati u Općinskom sudu u Lukavcu, sudnica broj 23.')).toBe(
      'Lukavcu, Bosnien-Herzegowina',
    )
    // also without the -u suffix (live case 159765)
    expect(extractLocation('u Općinskom sud u Lukavcu, kancelarija broj 23.')).toBe(
      'Lukavcu, Bosnien-Herzegowina',
    )
  })

  it('does not extract lowercase non-places ("sudu u skladu", live case 151315)', () => {
    expect(extractLocation('prijave svoja potraživanja stečajnom sudu u skladu (članom 105.)')).toBeNull()
  })

  it('returns null for text without location hints', () => {
    expect(extractLocation('Više informacija možete pogledati u kategoriji prateći dokumenti.')).toBeNull()
  })
})

describe('stripHtml', () => {
  it('converts <br> and </p> to newlines and strips tags', () => {
    expect(stripHtml('<p>Prvi red<br/>drugi &amp; red</p>')).toBe('Prvi red\ndrugi & red')
  })
})
