export type TourismLegendPanel = 'grid' | 'visitor' | 'legend'

// Each tourism legend's expanded panel (Map.client.vue, DetailMap.client.vue)
// is wide enough that two open at once can overlap or get clipped by the
// map's own overflow-hidden root on a narrow viewport — only one panel is
// ever expanded, regardless of which layer is active underneath it. The
// detail map shares its bottom-left corner with its feature legend, so that
// one ('legend') joins the same exclusivity there.
export function useTourismLegendPanels(initial: TourismLegendPanel | null = null) {
  const openPanel = ref<TourismLegendPanel | null>(initial)
  function panelOpen(panel: TourismLegendPanel) {
    return computed({
      get: () => openPanel.value === panel,
      set: (v: boolean) => {
        if (v) openPanel.value = panel
        else if (openPanel.value === panel) openPanel.value = null
      },
    })
  }
  return {
    tourismGridPanelOpen: panelOpen('grid'),
    tourismVisitorPanelOpen: panelOpen('visitor'),
    legendPanelOpen: panelOpen('legend'),
  }
}
