// Quick feedback loop for photo extraction on AT and BE detail pages.
// Run: node scripts/test-photo-extraction.mjs
import { fetchDetail as fetchAtDetail } from '../server/crawlers/at/detail.ts'
import { fetchDetail as fetchBidditDetail } from '../server/crawlers/biddit/detail.ts'

async function testAt() {
  const url = 'https://edikte.justiz.gv.at/edikte/ex/exedi3.nsf/alldoc/62af2c93a0d4c4e1c1258d1c00225860!OpenDocument'
  console.log('=== AT ===')
  console.log('URL:', url)
  const info = await fetchAtDetail(url)
  console.log('fotoCount:', info.fotoCount)
  console.log('thumbnailUrl:', info.thumbnailUrl)
  const photos = info.attachments.filter((a) => a.kind === 'foto')
  console.log(`photos (${photos.length}):`)
  for (const p of photos.slice(0, 3)) {
    console.log('  -', p.label, '|', p.proxyUrl)
  }
  console.log(
    'attachment kinds:',
    Object.fromEntries(
      [...new Set(info.attachments.map((a) => a.kind))].map((k) => [
        k,
        info.attachments.filter((a) => a.kind === k).length,
      ]),
    ),
  )
}

async function testBiddit() {
  console.log('\n=== BE (Biddit) ===')
  const searchUrl =
    'https://www.biddit.be/api/eco/search-service/lot/_search?page=0&pageSize=3&handlingMethods=ONLINE_PUBLIC_SALE'
  const res = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
      Referer: 'https://www.biddit.be/',
    },
  })
  const body = await res.text()
  let list
  try {
    list = JSON.parse(body)
  } catch {
    console.log('non-JSON response head:', body.slice(0, 300))
    return
  }
  const items = list?.content ?? []
  console.log('search top-level keys:', Object.keys(list ?? {}))
  console.log('sample items:', items.length)
  const ref = items[0]?.content?.referenceCode ?? items[0]?.referenceCode
  if (!ref) {
    console.log('no ref; sample:', JSON.stringify(items[0] ?? list, null, 2).slice(0, 400))
    return
  }
  console.log('ref:', ref)
  const info = await fetchBidditDetail(ref)
  if (!info) {
    console.log('no detail')
    return
  }
  console.log('fotoCount:', info.fotoCount)
  console.log('thumbnailUrl:', info.thumbnailUrl)
  const photos = info.attachments.filter((a) => a.kind === 'foto')
  console.log(`photos (${photos.length}):`)
  for (const p of photos.slice(0, 3)) {
    console.log('  -', p.label, '|', p.proxyUrl)
  }
}

await testAt()
await testBiddit()
