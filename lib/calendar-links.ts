// Client-side calendar links for an auction's Versteigerungstermin — no backend
// involved, so these are pure string builders the detail page renders as
// plain <a> hrefs (Google/Outlook web deeplinks) or a download link (.ics).

export interface CalendarEvent {
  title: string
  description?: string
  location?: string
  /** ISO 8601 start timestamp. */
  startIso: string
}

/** Versteigerungstermine don't carry an end time upstream — 2 hours covers the
 *  typical hearing without under-blocking the calendar. */
const DEFAULT_DURATION_HOURS = 2

/** UTC basic format required by both Google Calendar and the .ics spec: YYYYMMDDTHHMMSSZ. */
function toUtcBasic(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function eventBounds(event: CalendarEvent): { start: Date; end: Date } {
  const start = new Date(event.startIso)
  const end = new Date(start.getTime() + DEFAULT_DURATION_HOURS * 3_600_000)
  return { start, end }
}

export function googleCalendarUrl(event: CalendarEvent): string {
  const { start, end } = eventBounds(event)
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${toUtcBasic(start)}/${toUtcBasic(end)}`,
  })
  if (event.description) params.set('details', event.description)
  if (event.location) params.set('location', event.location)
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

export function outlookCalendarUrl(event: CalendarEvent): string {
  const { start, end } = eventBounds(event)
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: event.title,
    startdt: start.toISOString(),
    enddt: end.toISOString(),
  })
  if (event.description) params.set('body', event.description)
  if (event.location) params.set('location', event.location)
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`
}

function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n')
}

/** Returns a `data:` URI for a minimal single-event .ics file, suitable as an `<a download>` href. */
export function icsDataUrl(event: CalendarEvent): string {
  const { start, end } = eventBounds(event)
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//zvg-immo//auction-detail//DE',
    'BEGIN:VEVENT',
    `UID:${toUtcBasic(start)}-${Math.random().toString(36).slice(2)}@zvg-immo`,
    `DTSTAMP:${toUtcBasic(new Date(start))}`,
    `DTSTART:${toUtcBasic(start)}`,
    `DTEND:${toUtcBasic(end)}`,
    `SUMMARY:${icsEscape(event.title)}`,
  ]
  if (event.description) lines.push(`DESCRIPTION:${icsEscape(event.description)}`)
  if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`)
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join('\r\n'))}`
}
