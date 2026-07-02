// Proxy for zvg-portal.de detail pages and PDF attachments.
// The upstream rejects requests whose Referer header is not a zvg-portal.de URL,
// so direct browser links from another origin always return literal "error".

const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'
const ALLOWED_BUTTONS = new Set(['showAnhang', 'showZvg'])

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const button = String(q.button ?? '')
  if (!ALLOWED_BUTTONS.has(button)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid button' })
  }

  const upstream = new URL('https://www.zvg-portal.de/index.php')
  upstream.searchParams.set('button', button)
  for (const key of ['land_abk', 'zvg_id', 'file_id']) {
    const v = q[key]
    if (typeof v === 'string' && v.length) upstream.searchParams.set(key, v)
  }

  const res = await fetch(upstream.toString(), {
    headers: {
      'User-Agent': UA,
      Accept: button === 'showAnhang' ? 'application/pdf,*/*' : 'text/html',
      'Accept-Language': 'de-DE,de;q=0.9',
      Referer: 'https://www.zvg-portal.de/index.php?button=Suchen',
    },
    signal: AbortSignal.timeout(20_000),
  })

  if (!res.ok) {
    throw createError({ statusCode: 502, statusMessage: `upstream ${res.status}` })
  }

  const contentType = res.headers.get('content-type') || ''
  const buf = Buffer.from(await res.arrayBuffer())

  if (buf.length < 64 && buf.toString('utf8').trim() === 'error') {
    throw createError({ statusCode: 502, statusMessage: 'ZVG-Portal hat die Anfrage abgelehnt' })
  }

  if (button === 'showAnhang' || contentType.includes('pdf')) {
    const zvgId = q.zvg_id ?? 'dokument'
    setHeader(event, 'content-type', 'application/pdf')
    setHeader(event, 'content-disposition', `inline; filename="bekanntmachung-${zvgId}.pdf"`)
    setHeader(event, 'cache-control', 'public, max-age=3600')
    return buf
  }

  // Detail page: rewrite upstream's relative resource URLs (images/foo.gif,
  // images/basis.css) to absolute zvg-portal.de URLs so they still load, and
  // route its internal index.php links through this proxy so the user doesn't
  // hit upstream directly (which fails without Referer). We deliberately do
  // NOT inject a <base> tag — that would also rebase our /api/zvg-proxy links
  // against zvg-portal.de and break every rewritten link.
  let html = buf.toString('utf8')
  html = html.replace(
    /\b(src|href)=(["']?)(images\/[^"'\s>]+)\2/gi,
    (_m, attr, q, path) => `${attr}=${q}https://www.zvg-portal.de/${path}${q}`,
  )
  // Rewrite internal links to go through our proxy. Covers three href shapes:
  //   index.php?button=...   (navigation)
  //   ?button=showAnhang&... (PDF attachment links — bare query strings)
  //   https://www.zvg-portal.de/{index.php,}?...
  // Trailing whitespace inside the attribute value is tolerated (upstream emits it).
  html = html.replace(
    /href=(["'])(?:https?:\/\/www\.zvg-portal\.de\/)?(?:index\.php)?\?([^"'>]+?)\s*\1/gi,
    (_m, q, qs) => `href=${q}/api/zvg-proxy?${qs.replace(/&amp;/g, '&')}${q}`,
  )
  setHeader(event, 'content-type', 'text/html; charset=utf-8')
  // Short max-age + must-revalidate: detail HTML rewrites are tweaked often
  // (e.g. earlier <base> bug stranded users on stale links for 10 min).
  setHeader(event, 'cache-control', 'public, max-age=60, must-revalidate')
  return html
})
