// supercluster 9.0.0 ships no type declarations of its own, and
// @types/supercluster is stuck on the pre-9.x CJS export shape — this covers
// only the subset of the API lib/marker-clusterer.ts actually calls.
declare module 'supercluster' {
  export interface PointFeature<P> {
    type: 'Feature'
    properties: P
    geometry: { type: 'Point'; coordinates: [number, number] }
  }

  export interface ClusterProperties {
    cluster: true
    cluster_id: number
    point_count: number
    point_count_abbreviated: number
  }

  export interface SuperclusterOptions {
    radius?: number
    maxZoom?: number
    minZoom?: number
    minPoints?: number
  }

  export default class Supercluster<P extends Record<string, unknown> = Record<string, unknown>> {
    constructor(options?: SuperclusterOptions)
    load(points: PointFeature<P>[]): this
    getClusters(bbox: [number, number, number, number], zoom: number): Array<PointFeature<P> | PointFeature<ClusterProperties>>
    getClusterExpansionZoom(clusterId: number): number
    getLeaves(clusterId: number, limit?: number, offset?: number): PointFeature<P>[]
  }
}
