// Replicates the classic CSS map-pin trick (rounded square, one square
// corner, rotate(-45deg)) as a static SVG so it can be baked into an
// ol/style/Icon — used by both AuctionMap.client.vue (clustered pins) and
// AuctionDetailMap.client.vue (single property marker).
export function mapPinDataUri(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">`
    + `<path d="M16 6 A10 10 0 0 1 26 16 A10 10 0 0 1 16 26 L6 26 L6 16 A10 10 0 0 1 16 6 Z" `
    + `transform="rotate(-45 16 16)" fill="${color}" stroke="#fff" stroke-width="2"/>`
    + `<circle cx="16" cy="16" r="5" fill="#fff" opacity="0.9"/>`
    + `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

// The tip of the pin sits at (16, 26) in the 32x32 icon, so the anchor
// fraction is (0.5, 26/32) — the geo point should touch the pin's point.
export const MAP_PIN_ANCHOR: [number, number] = [0.5, 26 / 32]
