import { describe, expect, it } from 'vitest'
import { displayAuctionAddress, displayAuctionTitle, latinAddress } from './address-transliteration'

describe('latinAddress', () => {
  it('transliterates place names and localizes address terms', () => {
    expect(latinAddress('град Севлиево, ул. Великотърновско шосе №1, гр. Севлиево, Bulgarien', 'de'))
      .toBe('Stadt Sevlievo, Str. Velikotarnovsko shose №1, Stadt Sevlievo, Bulgarien')
    expect(latinAddress('село Неофит Рилски, общ. Ветрино, обл. Варна, с. Неофит Рилски, Bulgarien', 'en'))
      .toBe('village Neofit Rilski, municipality Vetrino, province Varna, village Neofit Rilski, Bulgarien')
  })

  it('applies the official word-final ия rule', () => {
    expect(latinAddress('Център, София, Bulgarien', 'de')).toBe('Tsentar, Sofia, Bulgarien')
    expect(latinAddress('Владая, област София', 'de')).toBe('Vladaya, Bezirk Sofia')
  })

  it('keeps all-caps words all caps and leaves quotes and numbers alone', () => {
    expect(latinAddress('ул. „ИВАН ВАЗОВ“ № 9, гр. НЕСЕБЪР, Bulgarien', 'de'))
      .toBe('Str. „IVAN VAZOV“ № 9, Stadt NESEBAR, Bulgarien')
    expect(latinAddress('местност БЯЛАТА ПРЪСТ, с. Белащица', 'de')).toBe('Flur BYALATA PRAST, Dorf Belashtitsa')
  })

  it('does not take a term out of a longer word', () => {
    // 'град' starts 'Градина', 'с.' must not match inside 'Остромила'.
    expect(latinAddress('Градина, Остромила, Пловдив', 'de')).toBe('Gradina, Ostromila, Plovdiv')
  })

  it('returns a non-Cyrillic address unchanged', () => {
    expect(latinAddress('Hauptstraße 1, 01067 Dresden', 'de')).toBe('Hauptstraße 1, 01067 Dresden')
  })
})

describe('displayAuctionAddress / displayAuctionTitle', () => {
  const auction = { title: 'Продава се къща', address: 'гр. Брезник, Bulgarien' }

  it('prefers a stored translation for the language', () => {
    const translated = { ...auction, translations: { de: { title: 'Haus zu verkaufen', address: 'Stadt Breznik, Bulgarien' } } }
    expect(displayAuctionTitle(translated, 'de')).toBe('Haus zu verkaufen')
    expect(displayAuctionAddress(translated, 'de')).toBe('Stadt Breznik, Bulgarien')
    expect(displayAuctionAddress(translated, 'en')).toBe('town Breznik, Bulgarien')
  })

  it('falls back to the transliterated address and the published title', () => {
    expect(displayAuctionAddress(auction, 'de')).toBe('Stadt Breznik, Bulgarien')
    expect(displayAuctionTitle(auction, 'de')).toBe('Продава се къща')
    expect(displayAuctionAddress({ address: null }, 'de')).toBeNull()
  })
})
