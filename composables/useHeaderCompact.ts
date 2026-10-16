// Shared "the header has collapsed" flag. SiteHeader owns the write (it
// watches scrolling, see components/site/SiteHeader.vue); the SearchBar and
// the buttons next to it read it to switch between their large and compact
// layouts. It's shared state rather than provide/inject because the bar is
// defined in a layout and only *rendered* inside SiteHeader's search slot —
// provide/inject follows template ownership there, not the rendered position.
export function useHeaderCompact() {
  return useState<boolean>('site-header-compact', () => false)
}
