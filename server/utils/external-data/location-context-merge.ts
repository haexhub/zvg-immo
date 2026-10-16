import type { LocationContext, LocationNoiseObservation } from '~/types/auction'

// The three environment enhancers (cams-air-quality.ts, eea-environmental-
// noise.ts, open-meteo-climate.ts) only ever overwrite their own field on a
// successful fetch — a transient failure (rate limit, timeout, WAF block)
// leaves it untouched in the freshly-built context, which starts every run
// with none of the previous run's data. Without this merge, a single bad
// night wipes that field from the persisted enrichment until the provider
// happens to succeed again, which reads as coverage flapping up and down
// instead of staying flat or climbing.
export function mergeLocationContextWithPrevious(
  context: LocationContext,
  previous: LocationContext | null,
): LocationContext {
  if (!previous) return context
  return {
    ...context,
    environment: {
      ...context.environment,
      airQuality: context.environment.airQuality ?? previous.environment.airQuality ?? null,
      climateNormals: context.environment.climateNormals ?? previous.environment.climateNormals ?? null,
      reportedNoise: mergeNoiseObservations(context.environment.reportedNoise, previous.environment.reportedNoise),
    },
  }
}

function mergeNoiseObservations(
  fresh: LocationNoiseObservation[] | undefined,
  previous: LocationNoiseObservation[] | undefined,
): LocationNoiseObservation[] {
  const byKey = new Map<string, LocationNoiseObservation>()
  for (const observation of previous ?? []) byKey.set(`${observation.source}:${observation.indicator}`, observation)
  for (const observation of fresh ?? []) byKey.set(`${observation.source}:${observation.indicator}`, observation)
  return [...byKey.values()]
}
