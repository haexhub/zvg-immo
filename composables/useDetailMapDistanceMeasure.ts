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
  formatMeasuredKm,
  measureDistanceKm,
  measureHintKey,
  nextMeasureState,
  type LngLat,
  type MeasureState,
} from '~/lib/distance-measure'

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
 * Two-point distance measurement for DetailMap.client.vue. `layer` goes into
 * the map's constructor like useDetailMapTourismLayers' layers. Clicks are
 * taken from `singleclick`, not `click`: a double-click zoom fires `click`
 * twice and would otherwise drop A and B onto the same spot. The caller's own
 * popup click handler has to bail out while `active` is true.
 */
export function useDetailMapDistanceMeasure(options: { map: Ref<OlMap | null> }) {
  const { t } = useI18n()
  const intlLocale = useIntlLocale()
  const active = ref(false)
  const state = shallowRef<MeasureState>(EMPTY_MEASURE)

  const source = new VectorSource()
  const layer = new VectorLayer({
    source,
    zIndex: MEASURE_LAYER_Z_INDEX,
    style: (feature) => {
      if (feature.getGeometry()?.getType() !== 'LineString') return pointStyle
      const { a, b } = state.value
      if (!a || !b) return lineCasing
      return [
        lineCasing,
        new Style({
          stroke: new Stroke({ color: MEASURE_COLOR, width: 3 }),
          text: new Text({
            text: t('map.measureDistanceKm', { km: formatMeasuredKm(measureDistanceKm(a, b), intlLocale.value) }),
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

  function render(): void {
    source.clear()
    const { a, b } = state.value
    const points = [a, b].filter((p): p is LngLat => p != null).map((p) => fromLonLat(p))
    source.addFeatures(points.map((coordinate) => new Feature(new Point(coordinate))))
    if (points.length === 2) source.addFeature(new Feature(new LineString(points)))
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
    state.value = EMPTY_MEASURE
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
      state.value = nextMeasureState(state.value, toLonLat(evt.coordinate) as LngLat)
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

  const hint = computed(() => {
    const key = measureHintKey(active.value, state.value)
    return key ? t(key) : null
  })

  const distanceLabel = computed(() => {
    const { a, b } = state.value
    if (!a || !b) return null
    return t('map.measureDistanceKm', { km: formatMeasuredKm(measureDistanceKm(a, b), intlLocale.value) })
  })

  return { layer, active, hint, distanceLabel, toggle, deactivate }
}
