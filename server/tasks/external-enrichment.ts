import { runExternalEnrichmentTask } from '../utils/tasks/external-enrichment-task'
import type { ExternalEnrichmentOptions } from '../utils/tasks/external-enrichment-task'

export {
  runExternalEnrichment,
  runExternalEnrichmentTask,
  withLocationContextEnhancers,
} from '../utils/tasks/external-enrichment-task'
export type {
  ExternalEnrichmentOptions,
  ExternalEnrichmentSummary,
  HazardAssessmentAdapter,
  LandValueBaselineAdapter,
  LocationContextAdapter,
  LocationContextEnhancer,
  MarketComparisonAdapter,
} from '../utils/tasks/external-enrichment-task'

export default defineTask({
  meta: {
    name: 'external-enrichment',
    description: 'Refresh cached external market and natural-hazard overlays for auction detail pages.',
  },
  async run(event) {
    return await runExternalEnrichmentTask((event?.payload ?? {}) as ExternalEnrichmentOptions)
  },
})
