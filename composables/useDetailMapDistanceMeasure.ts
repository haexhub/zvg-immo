import type OlMap from 'ol/Map'
import type { EventsKey } from 'ol/events'
import { unByKey } from 'ol/Observable'
import { Feature } from 'ol'
import LineString from 'ol/geom/LineString'
import Point from 'ol/geom/Point'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import { fromLonLat, toLonLat } from 'ol/proj'
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style'
import {
  EMPTY_MEASURE,
  addMeasurePoint,
  discardPending,
  formatMeasuredKm,
  measureDistanceKm,
  measureHintKey,
  removeMeasurement,
  type LngLat,
  type Measurement,
  type MeasureState,
} from '~/lib/distance-measure'
import { useDetailMapMeasureRemoveButton } from '~/composables/useDetailMapMeasureRemoveButton'

const MEASURE_COLOR = '#2563eb'
// Above the hovered hazard/feature layers (10) so the line stays readable on
// top of POI markers, below the subject pin (20) which must always win.
const MEASURE_LAYER_Z_INDEX = 15

const pointStyle = new Style({
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({ color: '#ffffff' }),
    stroke: new Stroke({ color: MEASURE_COLOR, width: 3 }),
  }),
})
const lineCasing = new Style({ stroke: new Stroke({ color: 'rgba(255, 255, 255, 0.9)', width: 6 }) })

/**
 * Distance measurement for DetailMap.client.vue. Finished A–B measurements
 * stay on the map (also after leaving the mode) until they are removed; only a
 * lone point A is dropped on exit. `layer` goes into the map's constructor
 * like useDetailMapTourismLayers' layers. Clicks are taken from `singleclick`,
 * not `click`: a double-click zoom fires `click` twice and would otherwise
 * drop A and B onto the same spot. The caller's own popup click handler has to
 * bail out while `active` is true.
 */
export function useDetailMapDistanceMeasure(options: { map: Ref<OlMap | null> }) {
  const { t } = useI18n()
  const intlLocale = useIntlLocale()
  const active = ref(false)
  const state = shallowRef<MeasureState>(EMPTY_MEASURE)

  function measurementLabel(m: Measurement): string {
    return t('map.measureDistanceKm', { km: formatMeasuredKm(measureDistanceKm(m.a, m.b), intlLocale.value) })
  }

  const source = new VectorSource()
  const layer = new VectorLayer({
    source,
    zIndex: MEASURE_LAYER_Z_INDEX,
    style: (feature) => {
      if (feature.getGeometry()?.getType() !== 'LineString') return pointStyle
      const measurement = state.value.measurements.find((m) => m.id === feature.get('measurementId'))
      if (!measurement) return lineCasing
      return [
        lineCasing,
        new Style({
          stroke: new Stroke({ color: MEASURE_COLOR, width: 3 }),
          text: new Text({
            text: measurementLabel(measurement),
            font: '600 13px sans-serif',
            fill: new Fill({ color: '#111827' }),
            stroke: new Stroke({ color: '#ffffff', width: 4 }),
            offsetY: -12,
            overflow: true,
          }),
        }),
      ]
    },
  })

  // Lines first so the end points are drawn on top of them. Every feature of a
  // finished measurement carries its id; the pending point A has none.
  function render(): void {
    source.clear()
    const features: Feature[] = []
    for (const m of state.value.measurements) {
      const a = fromLonLat(m.a)
      const b = fromLonLat(m.b)
      for (const geometry of [new LineString([a, b]), new Point(a), new Point(b)]) {
        const feature = new Feature(geometry)
        feature.set('measurementId', m.id)
        features.push(feature)
      }
    }
    if (state.value.pending) features.push(new Feature(new Point(fromLonLat(state.value.pending))))
    source.addFeatures(features)
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') deactivate()
  }

  function activate(): void {
    active.value = true
    window.addEventListener('keydown', onKeydown)
  }

  function deactivate(): void {
    active.value = false
    state.value = discardPending(state.value)
    render()
    window.removeEventListener('keydown', onKeydown)
  }

  function toggle(): void {
    if (active.value) deactivate()
    else activate()
  }

  let clickKey: EventsKey | null = null
  watch(options.map, (map) => {
    if (clickKey) unByKey(clickKey)
    clickKey = map?.on('singleclick', (evt) => {
      if (!active.value) return
      state.value = addMeasurePoint(state.value, toLonLat(evt.coordinate) as LngLat)
      render()
    }) ?? null
  }, { immediate: true })

  // The distance label is rendered by the style function above, so a locale
  // switch only needs a redraw, not new features.
  watch(intlLocale, () => layer.changed())

  onScopeDispose(() => {
    if (clickKey) unByKey(clickKey)
    window.removeEventListener('keydown', onKeydown)
  })

  // Hovering a line shows a "×" that calls back into remove(); the button's
  // own composable keeps the pointer handling out of this one.
  const removeButton = useDetailMapMeasureRemoveButton({ map: options.map, layer, remove: (id) => remove(id) })

  function remove(id: number): void {
    state.value = removeMeasurement(state.value, id)
    render()
    removeButton.hideFor(id)
  }

  const measurements = computed(() => state.value.measurements.map((m) => ({ id: m.id, label: measurementLabel(m) })))

  // Everything the control component shows, bundled so the map component can
  // hand it over with a single v-bind (it is at the repo's 500-line limit).
  const controlProps = computed(() => {
    const key = measureHintKey(active.value, state.value)
    return {
      active: active.value,
      hint: key ? t(key) : null,
      distance: measurements.value.at(-1)?.label ?? null,
      measurements: measurements.value,
    }
  })

  return { layer, active, controlProps, toggle, remove }
}
