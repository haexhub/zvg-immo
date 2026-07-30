import type { Ref } from 'vue'
import type { AuctionDetail } from '~/server/api/auction/[platform]/[id].get'
import { isPassthroughLanguage, type ContentTargetLang } from '~/lib/content-language'
import {
  applyTranslatedExtractionTexts,
  extractTranslatableExtractionTexts,
  translationContentSource,
  type TranslatableExtractionTexts,
} from '~/lib/extraction-translation'
import { apiErrorMessage } from '~/lib/api-error'
import { fetchWithPendingRetry } from '~/lib/pending-retry'

interface AuctionTranslationResponse {
  title: string | null
  description: string | null
  documentSummary: string | null
  extractionTexts: TranslatableExtractionTexts | null
}

interface LoadedAuctionTranslation {
  lang: ContentTargetLang
  sourceKey: string
  payload: AuctionTranslationResponse
}

const TRANSLATION_PENDING_RETRY_MS = 2500
const TRANSLATION_PENDING_MAX_POLLS = 48

function targetContentLang(value: string): ContentTargetLang | null {
  return value === 'de' || value === 'en' ? value : null
}

function hasTranslatableContent(auction: AuctionDetail): boolean {
  return !(
    auction.title == null &&
    auction.description == null &&
    auction.extraction?.documentSummary == null &&
    extractTranslatableExtractionTexts(auction.extraction) == null
  )
}

function translationSourceKey(auction: AuctionDetail): string {
  return JSON.stringify(translationContentSource(auction))
}

function translationRequest(
  auction: AuctionDetail | null,
  locale: string,
): { lang: ContentTargetLang, sourceKey: string } | null {
  if (!auction || !hasTranslatableContent(auction)) return null
  const lang = targetContentLang(locale)
  if (!lang || isPassthroughLanguage(auction.country, lang)) return null
  return { lang, sourceKey: translationSourceKey(auction) }
}

export async function useAuctionDetailTranslation(options: {
  auction: Ref<AuctionDetail | null>
  platform: string
  id: string
}) {
  const { t, locale } = useI18n()
  const currentTranslationRequest = computed(() => translationRequest(options.auction.value, locale.value))
  const translationError = ref<string | null>(null)
  const { data: loadedTranslation, pending: translationFetchPending } = await useAsyncData<LoadedAuctionTranslation | null>(
    `auction-translation:${options.platform}:${options.id}`,
    async () => {
      const request = currentTranslationRequest.value
      if (!request) return null
      try {
        const payload = await $fetch<AuctionTranslationResponse | null>(
          `/api/auction/${encodeURIComponent(options.platform)}/${encodeURIComponent(options.id)}/translation`,
          { method: 'POST', query: { lang: request.lang, cacheOnly: '1' } },
        )
        if (!payload) return null
        return { ...request, payload }
      } catch (err) {
        translationError.value = apiErrorMessage(err, t('objektDetail.translationError'))
        return null
      }
    },
    { default: () => null, watch: [currentTranslationRequest] },
  )

  const activeTranslation = computed(() => {
    const request = currentTranslationRequest.value
    const loaded = loadedTranslation.value
    if (!request || !loaded) return null
    return loaded.lang === request.lang && loaded.sourceKey === request.sourceKey ? loaded.payload : null
  })

  const translatedTitle = computed(() => activeTranslation.value?.title ?? null)
  const translatedDescription = computed(() => activeTranslation.value?.description ?? null)
  const translatedDocumentSummary = computed(() => activeTranslation.value?.documentSummary ?? null)
  const translatedExtractionTexts = computed(() => activeTranslation.value?.extractionTexts ?? null)
  const translationGenerationPending = ref(false)
  const translationPending = computed(
    () => currentTranslationRequest.value != null && (translationFetchPending.value || translationGenerationPending.value),
  )

  const displayTitle = computed(() => translatedTitle.value ?? options.auction.value?.title ?? null)
  const displayDescription = computed(() => translatedDescription.value ?? options.auction.value?.description ?? null)
  const displayDocumentSummary = computed(
    () => translatedDocumentSummary.value ?? options.auction.value?.extraction?.documentSummary ?? null,
  )
  const displayExtraction = computed(() => applyTranslatedExtractionTexts(
    options.auction.value?.extraction,
    translatedExtractionTexts.value,
  ) ?? null)
  const titleTranslated = computed(() => translatedTitle.value != null)
  const descriptionTranslated = computed(
    () => translatedDescription.value != null || translatedDocumentSummary.value != null,
  )
  const sourceExtraction = computed(() => options.auction.value?.extraction ?? null)
  const auctionDataTranslating = computed(() => translationPending.value && !!sourceExtraction.value?.biddingNotes)
  const propertyDataTranslating = computed(
    () => translationPending.value && !!(sourceExtraction.value?.floor || sourceExtraction.value?.renovationNotes),
  )
  const amenitiesTranslating = computed(
    () => translationPending.value && !!(sourceExtraction.value?.heating || sourceExtraction.value?.insights?.construction),
  )
  const descriptionTranslating = computed(
    () => translationPending.value && !!(
      options.auction.value?.description?.trim() ||
      sourceExtraction.value?.documentSummary?.trim()
    ),
  )
  const defectsTranslating = computed(() => translationPending.value && !!sourceExtraction.value?.insights?.defects?.length)
  const encumbrancesTranslating = computed(() => translationPending.value && !!sourceExtraction.value?.insights?.encumbrances?.length)
  const constructionTranslating = computed(() => translationPending.value && !!sourceExtraction.value?.insights?.construction)
  const locationCharacterTranslating = computed(() => translationPending.value && !!sourceExtraction.value?.insights?.locationCharacter)
  const planningNotesTranslating = computed(() => {
    const p = sourceExtraction.value?.planningNotes
    return translationPending.value && !!p && (
      p.monumentProtection != null ||
      p.contamination != null ||
      p.developmentPlan != null ||
      p.landConsolidation != null ||
      p.developmentCharges != null ||
      p.redevelopmentArea != null ||
      p.conservationArea != null
    )
  })
  const parcelsTranslating = computed(() => translationPending.value && !!sourceExtraction.value?.planningNotes?.landParcels?.length)

  const translationSeq = ref(0)

  watch([currentTranslationRequest, activeTranslation, translationFetchPending], async ([request, existing, cacheLookupPending]) => {
    if (import.meta.server) return
    const seq = ++translationSeq.value
    translationGenerationPending.value = false
    if (!request || existing || cacheLookupPending) return

    translationGenerationPending.value = true
    translationError.value = null
    try {
      const payload = await fetchWithPendingRetry(
        () => $fetch<AuctionTranslationResponse>(
          `/api/auction/${encodeURIComponent(options.platform)}/${encodeURIComponent(options.id)}/translation`,
          { method: 'POST', query: { lang: request.lang } },
        ),
        {
          maxPolls: TRANSLATION_PENDING_MAX_POLLS,
          retryMs: TRANSLATION_PENDING_RETRY_MS,
          shouldContinue: () => seq === translationSeq.value,
        },
      )
      if (!payload) return
      if (seq !== translationSeq.value) return
      loadedTranslation.value = { ...request, payload }
    } catch (err) {
      if (seq === translationSeq.value) {
        translationError.value = apiErrorMessage(err, t('objektDetail.translationError'))
      }
    } finally {
      if (seq === translationSeq.value) translationGenerationPending.value = false
    }
  }, { immediate: true })

  return {
    translationError,
    translationPending,
    displayTitle,
    displayDescription,
    displayDocumentSummary,
    displayExtraction,
    titleTranslated,
    descriptionTranslated,
    auctionDataTranslating,
    propertyDataTranslating,
    amenitiesTranslating,
    descriptionTranslating,
    defectsTranslating,
    encumbrancesTranslating,
    constructionTranslating,
    locationCharacterTranslating,
    planningNotesTranslating,
    parcelsTranslating,
  }
}
