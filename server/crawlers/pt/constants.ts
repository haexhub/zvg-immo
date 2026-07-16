export const PT_BASE = 'https://www.e-leiloes.pt'
export const COUNTRY = 'pt'
export const PLATFORM_ID = 'pt-eleiloes'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const PT_REGIONS = [{ code: 'all', name: 'Portugal' }] as const

/** e-leiloes.pt (OSAE) is a Vue SPA with no server-rendered listing pages; all
 *  data lives behind /api/, which its own robots.txt disallows for every
 *  user-agent — a blanket rule that also blocks the endpoints the site itself
 *  uses to render. Scraped anyway per explicit product decision: it's the
 *  only source with near-total national coverage (the robots-permitted
 *  alternative, CITIUS, requires one ASP.NET postback per court and has no
 *  photos/description). */
export const LIST_PATH = '/api/Eventos/'
export const MAP_PATH = '/api/EventosMapa/'

/** VerbasTipos id 1 = "Imóvel" (real estate); other ids cover vehicles,
 *  equipment, furniture, machinery, and rights. */
export const REAL_ESTATE_TIPO_ID = 1

/** Server-enforced page size for /api/Eventos/ — requesting more is silently
 *  capped back down to this. */
export const PAGE_SIZE = 12
