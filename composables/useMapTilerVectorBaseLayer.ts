import { apply } from 'ol-mapbox-style'
import LayerGroup from 'ol/layer/Group'
import type OlMap from 'ol/Map'
import { localizeVectorStyleLanguage, type MapboxStyle } from '~/lib/map-tiles'

/** Renders a MapTiler vector style as the map's base layer, keeping its
 *  place-name labels localized to `lang` (see localizeVectorStyleLanguage in
 *  lib/map-tiles.ts). OpenLayers has no live equivalent of MapLibre GL JS's
 *  `map.setLayoutProperty`, so a style/locale change clears and re-applies
 *  the whole layer group instead of mutating it in place. */
export function useMapTilerVectorBaseLayer(options: {
  map: Ref<OlMap | null>
  styleUrl: ComputedRef<string>
  lang: ComputedRef<string>
}) {
  const group = new LayerGroup()
  let inserted = false
  let generation = 0

  async function refresh(): Promise<void> {
    const mapInstance = options.map.value
    const url = options.styleUrl.value
    if (!mapInstance || !url) return
    if (!inserted) {
      mapInstance.getLayers().insertAt(0, group)
      inserted = true
    }
    const thisGeneration = ++generation
    try {
      const rawStyle = await $fetch<MapboxStyle>(url)
      if (thisGeneration !== generation) return // superseded by a newer style/lang change
      const localizedStyle = localizeVectorStyleLanguage(rawStyle, options.lang.value)
      group.getLayers().clear()
      // `styleUrl` is mandatory when the style is handed over as an object:
      // ol-mapbox-style derives the API key from the style URL's query string
      // (apply.js's completeOptions) and resolves the style's sprite/glyphs
      // against it. Without it those requests go out keyless and MapTiler
      // rejects them — no icons and no labels at all.
      await apply(group, localizedStyle, { styleUrl: url })
    } catch (err) {
      console.warn(`[map-tiles] failed to load/apply MapTiler style ${url}: ${(err as Error).message}`)
    }
  }

  watch([options.map, options.styleUrl, options.lang], refresh, { immediate: true })

  return { group }
}
