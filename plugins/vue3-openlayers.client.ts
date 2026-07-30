import { Map, Layers, Sources } from 'vue3-openlayers'
import 'ol/ol.css'
import 'vue3-openlayers/vue3-openlayers.css'

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.use(Map)
  nuxtApp.vueApp.use(Layers)
  nuxtApp.vueApp.use(Sources)
})
