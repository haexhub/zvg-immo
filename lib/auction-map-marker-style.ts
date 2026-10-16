import { Circle as CircleStyle, Fill, Icon, Stroke, Style, Text } from 'ol/style'
import { mapPinDataUri, MAP_PIN_ANCHOR } from '~/lib/mapPinIcon'

const PIN_COLOR = '#2563eb'
const PIN_COLOR_ACTIVE = '#dc2626'
const pinStyleDefault = new Style({ image: new Icon({ src: mapPinDataUri(PIN_COLOR), anchor: MAP_PIN_ANCHOR }) })
const pinStyleActive = new Style({ image: new Icon({ src: mapPinDataUri(PIN_COLOR_ACTIVE), anchor: MAP_PIN_ANCHOR }) })

export function pinStyle(active: boolean): Style {
  return active ? pinStyleActive : pinStyleDefault
}

// renderView() in Map.client.vue builds one OL feature per cluster/point
// returned by the clusterer for the current viewport, tagging each with
// 'isCluster' (+ 'count' for clusters) — so this single style function
// covers both individual pins and cluster badges. OL calls this for every
// visible feature on every render pass (pan/zoom/refresh), so cluster badge
// styles are cached like the singleton pin styles above instead of rebuilt
// each time.
const clusterStyleCache = new Map<string, Style>()
export function clusterStyle(feature: any): Style {
  if (!feature.get('isCluster')) {
    return pinStyle(feature.get('active') === true)
  }
  const count = feature.get('count') as number
  const active = feature.get('active') === true
  const cacheKey = `${count}:${active}`
  let style = clusterStyleCache.get(cacheKey)
  if (!style) {
    const color = active ? PIN_COLOR_ACTIVE : PIN_COLOR
    style = new Style({
      image: new CircleStyle({ radius: 18, fill: new Fill({ color }), stroke: new Stroke({ color: '#fff', width: 2 }) }),
      text: new Text({ text: String(count), fill: new Fill({ color: '#fff' }), font: 'bold 12px sans-serif' }),
    })
    clusterStyleCache.set(cacheKey, style)
  }
  return style
}
