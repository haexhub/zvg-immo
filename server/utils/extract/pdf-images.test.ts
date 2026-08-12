import { describe, expect, it } from 'vitest'
import {
  dedupByHash,
  execErrorMessage,
  filterImages,
  findFragmentedImageClusters,
  parseImageLayoutXml,
  parseImageList,
} from './pdf-images'

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

const KRONOFOGDEN_FRAGMENT_LIST = `page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio
--------------------------------------------------------------------------------------------
  17    58 image     900   388  rgb     3   8  jpeg   no       169  0   300   300 46.1K 4.5%
  17    59 image     900   388  rgb     3   8  jpeg   no       170  0   300   300 32.1K 3.1%
  17    60 image     900    43  rgb     3   8  jpeg   no       171  0   300   300 3838B 3.3%
  17    61 image     601   581  rgb     3   8  jpeg   no       172  0   300   300 42.0K 4.1%
  17    62 image     601   581  rgb     3   8  jpeg   no       173  0   300   300 42.1K 4.1%
  17    63 image     601   200  rgb     3   8  jpeg   no       174  0   300   300 12.7K 3.6%
  17    64 image     900   388  rgb     3   8  jpeg   no       175  0   300   300 32.0K 3.1%
`

const KRONOFOGDEN_FRAGMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<pdf2xml>
<page number="17" position="absolute" top="0" left="0" height="1262" width="892">
<image top="195" left="177" width="324" height="140" src="out-17_1.jpg"/>
<image top="334" left="177" width="324" height="139" src="out-17_2.jpg"/>
<image top="473" left="177" width="324" height="15" src="out-17_3.jpg"/>
<image top="195" left="500" width="216" height="209" src="out-17_4.jpg"/>
<image top="403" left="500" width="216" height="209" src="out-17_5.jpg"/>
<image top="612" left="500" width="216" height="72" src="out-17_6.jpg"/>
<image top="488" left="177" width="324" height="140" src="out-17_7.jpg"/>
</page>
</pdf2xml>`

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

describe('parseImageLayoutXml', () => {
  it('parses pdftohtml image placements and attaches pdfimages nums by page order', () => {
    const imageList = parseImageList(KRONOFOGDEN_FRAGMENT_LIST)
    const pages = parseImageLayoutXml(KRONOFOGDEN_FRAGMENT_XML, imageList)

    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ page: 17, width: 892, height: 1262 })
    expect(pages[0]?.images[0]).toMatchObject({ page: 17, num: 58, left: 177, top: 195, width: 324, height: 140 })
    expect(pages[0]?.images[6]).toMatchObject({ page: 17, num: 64 })
  })
})

describe('findFragmentedImageClusters', () => {
  it('groups adjacent PDF image tiles into one renderable crop', () => {
    const imageList = parseImageList(KRONOFOGDEN_FRAGMENT_LIST)
    const wantedKeys = new Set(filterImages(imageList).map((i) => `${i.page}:${i.num}`))
    const pages = parseImageLayoutXml(KRONOFOGDEN_FRAGMENT_XML, imageList)
    const clusters = findFragmentedImageClusters(pages, wantedKeys)

    expect(clusters).toHaveLength(1)
    expect(clusters[0]).toMatchObject({
      page: 17,
      num: 58,
      left: 175,
      top: 193,
      width: 543,
      height: 493,
      imageKeys: ['17:58', '17:59', '17:60', '17:61', '17:62', '17:63', '17:64'],
    })
  })

  it('does not mark separated normal images as a fragmented crop', () => {
    const pages = parseImageLayoutXml(
      `<pdf2xml><page number="2" height="900" width="700">
        <image top="100" left="100" width="240" height="180"/>
        <image top="100" left="380" width="240" height="180"/>
        <image top="330" left="100" width="240" height="180"/>
      </page></pdf2xml>`,
    )

    expect(findFragmentedImageClusters(pages, new Set(['2:0']))).toEqual([])
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

describe('execErrorMessage', () => {
  it('passes short messages through unchanged', () => {
    expect(execErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('truncates messages beyond the length cap', () => {
    const message = 'x'.repeat(2000)
    const result = execErrorMessage(new Error(message))
    expect(result.length).toBeLessThan(message.length)
    expect(result).toContain('2000 chars total, truncated')
  })
})
