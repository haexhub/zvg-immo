import { describe, expect, it } from 'vitest'
import { googleCalendarUrl, icsDataUrl, outlookCalendarUrl } from './calendar-links'

const event = {
  title: 'Zwangsversteigerung — Musterstraße 1, 12345 Musterstadt',
  description: 'Amtsgericht Musterstadt · Az. 12 K 34/24',
  location: 'Musterstraße 1, 12345 Musterstadt',
  startIso: '2026-09-17T11:00:00+02:00',
}

describe('googleCalendarUrl', () => {
  it('encodes the event as a Google Calendar TEMPLATE deeplink with UTC dates', () => {
    const url = new URL(googleCalendarUrl(event))
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render')
    expect(url.searchParams.get('action')).toBe('TEMPLATE')
    expect(url.searchParams.get('text')).toBe(event.title)
    expect(url.searchParams.get('dates')).toBe('20260917T090000Z/20260917T110000Z')
    expect(url.searchParams.get('location')).toBe(event.location)
  })
})

describe('outlookCalendarUrl', () => {
  it('encodes the event as an Outlook Web compose deeplink', () => {
    const url = new URL(outlookCalendarUrl(event))
    expect(url.searchParams.get('subject')).toBe(event.title)
    expect(url.searchParams.get('startdt')).toBe(new Date(event.startIso).toISOString())
    expect(url.searchParams.get('enddt')).toBe(new Date(new Date(event.startIso).getTime() + 2 * 3_600_000).toISOString())
  })
})

describe('icsDataUrl', () => {
  it('produces a VCALENDAR data URI containing the event fields', () => {
    const decoded = decodeURIComponent(icsDataUrl(event).replace('data:text/calendar;charset=utf-8,', ''))
    expect(decoded).toContain('BEGIN:VCALENDAR')
    expect(decoded).toContain('DTSTART:20260917T090000Z')
    expect(decoded).toContain('DTEND:20260917T110000Z')
    expect(decoded).toContain('SUMMARY:Zwangsversteigerung — Musterstraße 1\\, 12345 Musterstadt')
    expect(decoded).toContain('END:VCALENDAR')
  })

  it('escapes commas and semicolons in text fields', () => {
    const decoded = decodeURIComponent(icsDataUrl({ ...event, location: 'A, B; C' }).replace('data:text/calendar;charset=utf-8,', ''))
    expect(decoded).toContain('LOCATION:A\\, B\\; C')
  })
})
