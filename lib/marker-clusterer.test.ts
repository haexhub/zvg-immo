import { describe, expect, it } from 'vitest'
import { createMarkerClusterer, type ClusteredFeature } from './marker-clusterer'

const WORLD_BBOX: [number, number, number, number] = [-180, -85, 180, 85]

function clusterIdOf(features: ClusteredFeature[]): number {
  const cluster = features.find((f): f is Extract<ClusteredFeature, { isCluster: true }> => f.isCluster)
  if (!cluster) throw new Error('expected a cluster in the result')
  return cluster.clusterId
}

describe('createMarkerClusterer', () => {
  it('clusters points that are close together at a low zoom', () => {
    const clusterer = createMarkerClusterer()
    clusterer.load([
      { key: 'a', lng: 13.4, lat: 52.5 },
      { key: 'b', lng: 13.41, lat: 52.51 },
      { key: 'c', lng: 100, lat: 10 },
    ])
    const result = clusterer.getClusters(WORLD_BBOX, 2)
    expect(result).toHaveLength(2)
    const cluster = result.find((f) => f.isCluster)
    expect(cluster).toMatchObject({ isCluster: true, count: 2 })
    const single = result.find((f) => !f.isCluster)
    expect(single).toMatchObject({ isCluster: false, key: 'c' })
  })

  it('splits a cluster into individual points at a high enough zoom', () => {
    const clusterer = createMarkerClusterer()
    clusterer.load([
      { key: 'a', lng: 13.4, lat: 52.5 },
      { key: 'b', lng: 13.6, lat: 52.6 },
    ])
    const result = clusterer.getClusters(WORLD_BBOX, 16)
    expect(result).toHaveLength(2)
    expect(result.every((f) => !f.isCluster)).toBe(true)
  })

  it('keeps points at the exact same coordinate clustered at every zoom the map UI reaches', () => {
    const clusterer = createMarkerClusterer()
    clusterer.load([
      { key: 'a', lng: 13.4, lat: 52.5 },
      { key: 'b', lng: 13.4, lat: 52.5 },
    ])
    const result = clusterer.getClusters(WORLD_BBOX, 18)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ isCluster: true, count: 2 })
    const clusterId = clusterIdOf(result)
    // Never actually splits — getExpansionZoom() returning something beyond
    // MAX_ZOOM (18 in Auction/Map.client.vue) is exactly the signal onMapClick
    // uses to fall back to the cluster-picker instead of zooming forever.
    expect(clusterer.getExpansionZoom(clusterId)).toBeGreaterThan(18)
    expect(clusterer.getLeafKeys(clusterId).sort()).toEqual(['a', 'b'])
  })

  it('getLeafKeys returns every leaf, not just the default limit of 10', () => {
    const clusterer = createMarkerClusterer()
    const points = Array.from({ length: 25 }, (_, i) => ({ key: `p${i}`, lng: 13.4, lat: 52.5 }))
    clusterer.load(points)
    const clusterId = clusterIdOf(clusterer.getClusters(WORLD_BBOX, 18))
    expect(clusterer.getLeafKeys(clusterId)).toHaveLength(25)
  })
})
