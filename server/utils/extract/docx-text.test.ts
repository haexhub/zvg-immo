import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { docxToText } from './docx-text'

function writeUInt16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}

function writeUInt32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

function zipWithDocumentXml(xml: string): Buffer {
  const name = Buffer.from('word/document.xml')
  const body = Buffer.from(xml)
  const compressed = deflateRawSync(body)
  const localHeader = Buffer.concat([
    writeUInt32(0x04034b50),
    writeUInt16(20),
    writeUInt16(0),
    writeUInt16(8),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(0),
    writeUInt32(compressed.length),
    writeUInt32(body.length),
    writeUInt16(name.length),
    writeUInt16(0),
    name,
  ])
  const local = Buffer.concat([localHeader, compressed])
  const central = Buffer.concat([
    writeUInt32(0x02014b50),
    writeUInt16(20),
    writeUInt16(20),
    writeUInt16(0),
    writeUInt16(8),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(0),
    writeUInt32(compressed.length),
    writeUInt32(body.length),
    writeUInt16(name.length),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(0),
    writeUInt32(0),
    name,
  ])
  const eocd = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(1),
    writeUInt16(1),
    writeUInt32(central.length),
    writeUInt32(local.length),
    writeUInt16(0),
  ])
  return Buffer.concat([local, central, eocd])
}

async function cleanup(url: string): Promise<void> {
  const key = createHash('sha1').update(url).digest('hex')
  await rm(join(process.cwd(), '.cache_zvg', 'docxtext', `${key}.txt`), { force: true })
}

function dataUrl(buf: Buffer): string {
  return `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${buf.toString('base64')}`
}

describe('docxToText', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('extracts word/document.xml text from a docx zip', async () => {
    const url = dataUrl(zipWithDocumentXml([
      '<w:document><w:body>',
      '<w:p><w:r><w:t>Price &amp; address</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>150.000 KM</w:t><w:tab/><w:t>KO Sarajevo</w:t></w:r></w:p>',
      '</w:body></w:document>',
    ].join('')))
    await cleanup(url)
    await expect(docxToText(url)).resolves.toBe('Price & address\n150.000 KM KO Sarajevo')
    await cleanup(url)
  })

  it('preserves explicit Word line breaks as newlines', async () => {
    const url = dataUrl(zipWithDocumentXml([
      '<w:document><w:body>',
      '<w:p><w:r><w:t>Address</w:t><w:br/><w:t>Second line</w:t></w:r></w:p>',
      '</w:body></w:document>',
    ].join('')))
    await cleanup(url)
    await expect(docxToText(url)).resolves.toBe('Address\nSecond line')
    await cleanup(url)
  })

  it('rejects responses with a content-length above the DOCX size cap', async () => {
    const url = 'https://example.test/too-large.docx'
    await cleanup(url)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { 'content-length': String(21 * 1024 * 1024) },
        }),
      ),
    )

    await expect(docxToText(url)).resolves.toBeNull()
    expect(fetch).toHaveBeenCalledOnce()
    await cleanup(url)
  })

  it('returns null for malformed docx content', async () => {
    const url = dataUrl(Buffer.from([0x50, 0x4b]))
    await cleanup(url)
    await expect(docxToText(url)).resolves.toBeNull()
    await cleanup(url)
  })
})
