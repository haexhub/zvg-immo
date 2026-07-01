import { describe, expect, it } from 'vitest'
import { dedupByHash, filterImages, parseImageList } from './pdf-images'

const LIST_FIXTURE = `page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio
--------------------------------------------------------------------------------------------
   1     0 image     800    600  rgb     3   8  jpeg   no       7  0   150   150   35K 2.4%
   1     1 image     120     40  rgb     3   8  png    no       8  0    96    96   2K 1.0%
   2     0 image    1200    900  rgb     3   8  jpx    no       9  0   200   200  150K 1.2%
   2     1 image     120     40  rgb     3   8  png    no      10  0    96    96   2K 1.0%
   3     0 image    1200    900  rgb     3   8  jpx    no      11  0   200   200  148K 1.2%
   4     0 image     800    100  rgb     3   8  jpeg   no      12  0   100   100    8K 1.0%
   5     0 smask     800    600  gray    1   8  image  no      13  0   150   150   12K 0.5%
   6     0 image     600    600  rgb     3   8  png    no      14  0   150   150   15K 1.0%
`

describe('parseImageList', () => {
  it('parses the tabular pdfimages -list output into structured info', () => {
    const items = parseImageList(LIST_FIXTURE)
    expect(items).toHaveLength(8)
    expect(items[0]).toEqual({
      page: 1, num: 0, type: 'image', width: 800, height: 600, color: 'rgb', enc: 'jpeg',
    })
    expect(items[2]).toMatchObject({ page: 2, num: 0, width: 1200, height: 900, enc: 'jpx' })
    expect(items[6]).toMatchObject({ type: 'smask' })
    expect(items[7]).toMatchObject({ page: 6, num: 0, width: 600, height: 600 })
  })

  it('returns empty array for an empty PDF', () => {
    const header = `page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio
--------------------------------------------------------------------------------------------
`
    expect(parseImageList(header)).toEqual([])
  })

  it('ignores malformed lines without throwing', () => {
    expect(parseImageList('garbage\n   1     0 image not-a-number 600  rgb 3 8 jpeg no 7 0 150 150 35K 2.4%\n')).toEqual([])
  })
})

describe('filterImages', () => {
  it('drops images smaller than the size threshold', () => {
    const all = parseImageList(LIST_FIXTURE)
    const kept = filterImages(all)
    expect(kept.find((i) => i.width === 120)).toBeUndefined()
  })

  it('drops mask layers (smask/mask)', () => {
    const all = parseImageList(LIST_FIXTURE)
    const kept = filterImages(all)
    expect(kept.find((i) => i.type !== 'image')).toBeUndefined()
  })

  it('drops images with extreme aspect ratios', () => {
    const all = parseImageList(LIST_FIXTURE)
    const kept = filterImages(all)
    expect(kept.find((i) => i.page === 4 && i.num === 0)).toBeUndefined()
  })

  it('drops near-square smallish images (typical letterhead crests)', () => {
    const all = parseImageList(LIST_FIXTURE)
    const kept = filterImages(all)
    expect(kept.find((i) => i.page === 6 && i.width === 600 && i.height === 600)).toBeUndefined()
  })

  it('drops page-1 images (Gutachten cover pages)', () => {
    const all = parseImageList(LIST_FIXTURE)
    const kept = filterImages(all)
    expect(kept.find((i) => i.page === 1)).toBeUndefined()
  })

  it('keeps photos on later pages that are large enough and clearly non-square', () => {
    const all = parseImageList(LIST_FIXTURE)
    const kept = filterImages(all)
    expect(kept.map((i) => `${i.page}:${i.num}`)).toEqual(['2:0', '3:0'])
  })

  it('respects custom thresholds', () => {
    const all = parseImageList(LIST_FIXTURE)
    const kept = filterImages(all, { minWidth: 1500, minHeight: 1000 })
    expect(kept).toEqual([])
  })
})

describe('dedupByHash', () => {
  it('keeps first occurrence and drops later duplicates', () => {
    const items = [
      { name: 'a', hash: 'xx' },
      { name: 'b', hash: 'yy' },
      { name: 'c', hash: 'xx' },
      { name: 'd', hash: 'zz' },
    ]
    expect(dedupByHash(items).map((i) => i.name)).toEqual(['a', 'b', 'd'])
  })

  it('returns an empty array unchanged', () => {
    expect(dedupByHash([])).toEqual([])
  })
})
