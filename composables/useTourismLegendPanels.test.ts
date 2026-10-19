import { computed, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Nuxt auto-imports replaced with plain Vue reactivity.
beforeEach(() => {
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('ref', ref)
})

describe('useTourismLegendPanels', () => {
  it('starts with every panel closed by default', async () => {
    const { useTourismLegendPanels } = await import('./useTourismLegendPanels')
    const panels = useTourismLegendPanels()
    expect(panels.tourismGridPanelOpen.value).toBe(false)
    expect(panels.tourismVisitorPanelOpen.value).toBe(false)
    expect(panels.legendPanelOpen.value).toBe(false)
  })

  it('keeps at most one panel open, including the detail-map legend', async () => {
    const { useTourismLegendPanels } = await import('./useTourismLegendPanels')
    const panels = useTourismLegendPanels('legend')
    expect(panels.legendPanelOpen.value).toBe(true)

    panels.tourismGridPanelOpen.value = true
    expect(panels.legendPanelOpen.value).toBe(false)
    expect(panels.tourismGridPanelOpen.value).toBe(true)

    panels.tourismVisitorPanelOpen.value = true
    expect(panels.tourismGridPanelOpen.value).toBe(false)
    expect(panels.tourismVisitorPanelOpen.value).toBe(true)
  })

  it('closing a panel that is not open leaves the open one alone', async () => {
    const { useTourismLegendPanels } = await import('./useTourismLegendPanels')
    const panels = useTourismLegendPanels('legend')
    panels.tourismGridPanelOpen.value = false
    expect(panels.legendPanelOpen.value).toBe(true)
    panels.legendPanelOpen.value = false
    expect(panels.legendPanelOpen.value).toBe(false)
  })
})
