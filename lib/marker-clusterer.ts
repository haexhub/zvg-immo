import Supercluster from 'supercluster'

export interface ClusterPoint {
  key: string
  lng: number
  lat: number
}

interface ClusterPointProps extends Record<string, unknown> {
  key: string
}

export type ClusteredFeature =
  | { isCluster: true; lng: number; lat: number; clusterId: number; count: number }
  | { isCluster: false; lng: number; lat: number; key: string }

/** Wraps Supercluster (fast, hierarchical clustering — a full rebuild over a
 *  few thousand points costs low single-digit ms, see search-map-freeze
 *  investigation) behind the plain lng/lat point shape Auction/Map.client.vue
 *  needs, instead of exposing Supercluster's GeoJSON-ish feature objects. */
export function createMarkerClusterer(radius = 60) {
  // maxZoom deliberately kept above every zoom the map UI ever reaches
  // (MAX_ZOOM = 18 in Auction/Map.client.vue): points that share the exact
  // same coordinate (e.g. addresses that only resolved to a country/region
  // centroid) then stay clustered at any interactive zoom instead of
  // rendering as unclickable, fully overlapping singleton pins.
  const index = new Supercluster<ClusterPointProps>({ radius, maxZoom: 24 })

  function load(points: ClusterPoint[]): void {
    index.load(
      points.map((p) => ({
        type: 'Feature',
        properties: { key: p.key },
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      })),
    )
  }

  function getClusters(bbox: [number, number, number, number], zoom: number): ClusteredFeature[] {
    return index.getClusters(bbox, Math.round(zoom)).map((f): ClusteredFeature => {
      const [lng, lat] = f.geometry.coordinates
      const props = f.properties
      if ('cluster' in props && props.cluster) {
        const clusterProps = props as unknown as import('supercluster').ClusterProperties
        return { isCluster: true, lng, lat, clusterId: clusterProps.cluster_id, count: clusterProps.point_count }
      }
      return { isCluster: false, lng, lat, key: (props as ClusterPointProps).key }
    })
  }

  /** Zoom level at which this cluster splits into more than one child — see
   *  onMapClick in Auction/Map.client.vue for the "can't split" fallback. */
  function getExpansionZoom(clusterId: number): number {
    return index.getClusterExpansionZoom(clusterId)
  }

  function getLeafKeys(clusterId: number): string[] {
    return index.getLeaves(clusterId, Infinity).map((f) => f.properties.key)
  }

  return { load, getClusters, getExpansionZoom, getLeafKeys }
}

export type MarkerClusterer = ReturnType<typeof createMarkerClusterer>
