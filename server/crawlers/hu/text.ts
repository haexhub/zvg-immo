/**
 * ISO-8859-2 lookup for bytes 0xA0–0xFF (96 chars, indexed by byte - 0xA0).
 * Bytes 0x00–0x7F are ASCII (identical to Unicode).
 * Bytes 0x80–0x9F are C1 controls (same codepoints as in Unicode).
 * Bun's TextDecoder does not support iso-8859-2, so we decode manually.
 */
const ISO88592_A0 =
  ' Ą˘Ł¤ĽŚ§¨ŠŞŤŹ­ŽŻ' +
  '°ą˛ł´ľśˇ¸šşťź˝žż' +
  'ŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎ' +
  'ĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢß' +
  'ŕáâăäĺćçčéęëěíîď' +
  'đńňóôőö÷řůúűüýţ˙'

export function decodeIso8859_2(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const out: string[] = new Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    out[i] = b < 0xA0 ? String.fromCharCode(b) : (ISO88592_A0[b - 0xA0] ?? '�')
  }
  return out.join('')
}

/** "2026.07.13. 21:00" → "2026-07-13" */
export function parseMnvDate(raw: string): string | null {
  const m = raw.match(/(\d{4})\.(\d{2})\.(\d{2})\./)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** "1 038 000" or "36 500 000" → 1038000 (space-separated Hungarian thousands) */
export function parseMnvPrice(raw: string): number | null {
  const n = parseFloat(raw.replace(/\s/g, ''))
  return isNaN(n) || n <= 0 ? null : n
}

export function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
