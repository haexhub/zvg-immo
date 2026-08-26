export type TourismLegendPanel = 'grid' | 'visitor'

// Each tourism legend's expanded panel (Map.client.vue) is wide enough that
// both open at once can overlap or get clipped by the map's own
// overflow-hidden root on a narrow viewport — only one panel is ever
// expanded, regardless of which layer is active underneath it.
export function useTourismLegendPanels() {
  const openPanel = ref<TourismLegendPanel | null>(null)
  const tourismGridPanelOpen = computed({
    get: () => openPanel.value === 'grid',
    set: (v: boolean) => { openPanel.value = v ? 'grid' : null },
  })
  const tourismVisitorPanelOpen = computed({
    get: () => openPanel.value === 'visitor',
    set: (v: boolean) => { openPanel.value = v ? 'visitor' : null },
  })
  return { tourismGridPanelOpen, tourismVisitorPanelOpen }
}
