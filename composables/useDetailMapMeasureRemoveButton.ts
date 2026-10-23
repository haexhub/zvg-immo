import type OlMap from 'ol/Map'
import type { EventsKey } from 'ol/events'
import { unByKey } from 'ol/Observable'
import { Feature } from 'ol'
import type VectorLayer from 'ol/layer/Vector'
import type VectorSource from 'ol/source/Vector'
import Overlay from 'ol/Overlay'
import type { Coordinate } from 'ol/coordinate'
import { removeButtonOffset } from '~/lib/distance-measure'

// Same tolerance OL users expect for thin lines: a pointer a few pixels off
// the 3 px stroke still counts as "on the line".
const HIT_TOLERANCE = 6
// The button sits a little away from the line, so the pointer leaves the line
// before it reaches the button — this grace period bridges that gap.
const HIDE_DELAY_MS = 250

interface Hit {
  id: number
  coordinate: Coordinate
}

/**
 * The floating "×" that removes one distance measurement. A single DOM button
 * in an ol/Overlay is moved to whichever measurement is hovered (mouse) or was
 * tapped (touch, see the tap handler below). Because it is a real overlay
 * element, OpenLayers keeps its clicks away from the map: they neither set a
 * measuring point nor open or close a marker popup.
 */
export function useDetailMapMeasureRemoveButton(options: {
  map: Ref<OlMap | null>
  layer: VectorLayer<VectorSource>
  remove: (id: number) => void
}) {
  const { t } = useI18n()

  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = '×'
  button.className = 'flex size-6 cursor-pointer items-center justify-center rounded-full border border-slate-900/20 bg-white text-base leading-none font-bold text-red-600 shadow-md hover:bg-red-50'
  watchEffect(() => button.setAttribute('aria-label', t('map.measureRemove')))

  const overlay = new Overlay({ element: button, positioning: 'center-center' })

  let shownId: number | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let attachedMap: OlMap | null = null
  let keys: EventsKey[] = []
  let viewport: HTMLElement | null = null

  function cancelHide(): void {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = null
  }

  function hideNow(): void {
    cancelHide()
    shownId = null
    overlay.setPosition(undefined)
  }

  function scheduleHide(): void {
    cancelHide()
    hideTimer = setTimeout(hideNow, HIDE_DELAY_MS)
  }

  function show(hit: Hit): void {
    cancelHide()
    // Stay where it is while the pointer travels along the same line, so the
    // button doesn't run away from the cursor.
    if (shownId === hit.id) return
    const map = options.map.value
    if (!map) return
    shownId = hit.id
    const pixel = map.getPixelFromCoordinate(hit.coordinate)
    const size = map.getSize()
    if (pixel && size) overlay.setOffset(removeButtonOffset([pixel[0]!, pixel[1]!], [size[0]!, size[1]!]))
    overlay.setPosition(hit.coordinate)
  }

  /** Topmost measurement under the pixel, and the point of it closest to the
   *  pointer. Overlapping lines resolve to the one drawn last. */
  function hitAt(map: OlMap, pixel: number[]): Hit | null {
    const pointer = map.getCoordinateFromPixel(pixel)
    return map.forEachFeatureAtPixel(pixel, (feature): Hit | undefined => {
      // Only the measure layer is queried, so these are plain Features, but
      // forEachFeatureAtPixel types them as Feature | RenderFeature.
      if (!(feature instanceof Feature)) return undefined
      const id = feature.get('measurementId')
      const geometry = feature.getGeometry()
      if (typeof id !== 'number' || !geometry) return undefined
      return { id, coordinate: geometry.getClosestPoint(pointer) }
    }, { layerFilter: (candidate) => candidate === options.layer, hitTolerance: HIT_TOLERANCE }) ?? null
  }

  function detach(): void {
    unByKey(keys)
    keys = []
    viewport?.removeEventListener('pointerleave', scheduleHide)
    viewport = null
    attachedMap?.removeOverlay(overlay)
    attachedMap = null
    hideNow()
  }

  button.addEventListener('mouseenter', cancelHide)
  button.addEventListener('mouseleave', scheduleHide)
  button.addEventListener('click', () => {
    const id = shownId
    hideNow()
    if (id != null) options.remove(id)
  })

  watch(options.map, (map) => {
    detach()
    if (!map) return
    attachedMap = map
    map.addOverlay(overlay)
    viewport = map.getViewport()
    viewport.addEventListener('pointerleave', scheduleHide)
    keys = [
      map.on('pointermove', (evt) => {
        if (evt.dragging) return
        // OpenLayers relays pointermove from over overlay elements too (it
        // only swallows pointerdown there). While the pointer rests on the
        // button it is not "off the line", so keep the button.
        if (evt.originalEvent.target instanceof Node && button.contains(evt.originalEvent.target)) {
          cancelHide()
          return
        }
        const hit = hitAt(map, evt.pixel)
        if (hit) show(hit)
        else scheduleHide()
      }),
      // Touch has no hover: tapping a line brings the button up and a tap
      // anywhere else dismisses it. With a mouse the same click just
      // re-shows what hovering already showed.
      map.on('singleclick', (evt) => {
        const hit = hitAt(map, evt.pixel)
        if (hit) show(hit)
        else hideNow()
      }),
    ]
  }, { immediate: true })

  onScopeDispose(detach)

  /** Hide the button when the measurement it belongs to was removed elsewhere
   *  (e.g. through the keyboard-reachable list). */
  function hideFor(id: number): void {
    if (shownId === id) hideNow()
  }

  return { hideFor }
}
