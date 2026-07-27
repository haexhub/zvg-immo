import { describe, expect, it } from 'vitest'
import type { Attachment } from '~/types/auction'
import { htmlToText, pickAllLlmDocumentAttachments } from './llm-documents'

function att(overrides: Partial<Attachment>): Attachment {
  return {
    kind: 'other',
    label: '',
    filename: '',
    sizeBytes: null,
    fileId: '',
    proxyUrl: '',
    ...overrides,
  }
}

describe('pickAllLlmDocumentAttachments', () => {
  it('keeps every attachment kind, including photos and other documents, with stable priority ordering', () => {
    const picked = pickAllLlmDocumentAttachments([
      att({ kind: 'other', filename: 'terms.txt', proxyUrl: 'https://example.test/terms.txt' }),
      att({ kind: 'photo', filename: 'scan.jpg', proxyUrl: 'https://example.test/scan.jpg' }),
      att({ kind: 'appraisal', filename: 'gutachten.pdf', proxyUrl: 'https://example.test/gutachten.pdf' }),
      att({ kind: 'brochure', filename: 'expose.html', proxyUrl: 'https://example.test/expose.html' }),
      att({ kind: 'other', filename: 'dupe.txt', proxyUrl: 'https://example.test/terms.txt' }),
    ])

    expect(picked.map((item) => item.filename)).toEqual([
      'gutachten.pdf',
      'expose.html',
      'scan.jpg',
      'terms.txt',
    ])
  })
})

describe('htmlToText', () => {
  it('strips scripts/styles/tags and decodes common entities', () => {
    expect(
      htmlToText('<html><style>.x{}</style><script>alert(1)</script><body><h1>Wohnhaus</h1><p>140&nbsp;m&sup2; &amp; Garage</p></body></html>'),
    ).toContain('Wohnhaus\n140 m&sup2; & Garage')
  })
})
