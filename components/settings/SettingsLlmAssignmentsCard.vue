<script setup lang="ts">
import { useSettingsError } from '~/composables/settings/useSettingsError'
import type { LlmExecutionMode, LlmProvider, LlmProviderScope } from '~/server/utils/app-settings'

interface LlmProviderProfileForm {
  id: string
  name: string
  provider: LlmProvider
  baseUrl: string
  model: string
  executionMode: LlmExecutionMode
}

interface LlmProfilesResponse {
  profiles: LlmProviderProfileForm[]
  assignments: Partial<Record<LlmProviderScope, string>>
  effective: Record<LlmProviderScope, {
    provider: string
    baseUrl: string
    model: string
    executionMode: LlmExecutionMode
  }>
}

const { t } = useI18n()
const { normalizeSettingsError } = useSettingsError()

const LLM_PROVIDER_SCOPES: LlmProviderScope[] = ['extraction', 'translation']
const NO_LLM_PROFILE = '__none'
const llmProfiles = useState<LlmProviderProfileForm[]>('settings:llm-profile-options', () => [])
const llmProfileAssignments = reactive<Record<LlmProviderScope, string>>({
  extraction: NO_LLM_PROFILE,
  translation: NO_LLM_PROFILE,
})
const llmProfileEffective = ref<LlmProfilesResponse['effective'] | null>(null)
const llmAssignmentsError = ref<string | null>(null)
const llmAssignmentsSaved = ref(false)
const llmAssignmentsPending = ref(false)

async function loadLlmAssignments(): Promise<void> {
  try {
    const res = await $fetch<LlmProfilesResponse>('/api/settings/llm-profiles')
    llmProfiles.value = res.profiles.map(({ id, name, provider, baseUrl, model, executionMode }) => ({
      id,
      name,
      provider,
      baseUrl,
      model,
      executionMode,
    }))
    llmProfileAssignments.extraction = res.assignments.extraction ?? NO_LLM_PROFILE
    llmProfileAssignments.translation = res.assignments.translation ?? NO_LLM_PROFILE
    llmProfileEffective.value = res.effective
    llmAssignmentsError.value = null
  } catch (err) {
    llmAssignmentsError.value = normalizeSettingsError(err, t('settings.llmProvider.loadError'))
  }
}

async function saveLlmAssignments(): Promise<void> {
  llmAssignmentsPending.value = true
  llmAssignmentsError.value = null
  llmAssignmentsSaved.value = false
  try {
    await $fetch('/api/settings/llm-assignments', {
      method: 'PUT',
      body: {
        assignments: {
          extraction: llmProfileAssignments.extraction === NO_LLM_PROFILE ? undefined : llmProfileAssignments.extraction,
          translation: llmProfileAssignments.translation === NO_LLM_PROFILE ? undefined : llmProfileAssignments.translation,
        },
      },
    })
    await loadLlmAssignments()
    llmAssignmentsSaved.value = !llmAssignmentsError.value
  } catch (err) {
    llmAssignmentsError.value = normalizeSettingsError(err, t('settings.llmAssignment.saveError'))
  } finally {
    llmAssignmentsPending.value = false
  }
}

onMounted(loadLlmAssignments)
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ $t('settings.llmAssignment.title') }}</CardTitle>
    </CardHeader>
    <CardContent class="space-y-6">
      <p class="text-sm text-muted-foreground">
        {{ $t('settings.llmAssignment.description') }}
      </p>

      <p v-if="llmAssignmentsError" class="text-sm text-destructive">{{ llmAssignmentsError }}</p>
      <p v-if="llmAssignmentsSaved" class="text-sm text-emerald-600 dark:text-emerald-500">{{ $t('settings.llmAssignment.saved') }}</p>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div v-for="scope in LLM_PROVIDER_SCOPES" :key="scope" class="space-y-1">
          <Label>
            {{ scope === 'translation' ? $t('settings.llmAssignment.translationTitle') : $t('settings.llmAssignment.extractionTitle') }}
          </Label>
          <Select v-model="llmProfileAssignments[scope]">
            <SelectTrigger class="w-full">
              <SelectValue :placeholder="$t('settings.llmAssignment.noProfileAssigned')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="NO_LLM_PROFILE">{{ $t('settings.llmAssignment.noProfileAssigned') }}</SelectItem>
              <SelectItem v-for="profile in llmProfiles" :key="profile.id" :value="profile.id">
                {{ profile.name || profile.model }}
              </SelectItem>
            </SelectContent>
          </Select>
          <p v-if="llmProfileAssignments[scope] === NO_LLM_PROFILE && llmProfileEffective" class="text-xs text-muted-foreground">
            {{ $t(scope === 'translation' ? 'settings.llmAssignment.usingTranslationFallback' : 'settings.llmAssignment.usingEnvDefault', {
              provider: llmProfileEffective[scope].provider,
              baseUrl: llmProfileEffective[scope].baseUrl,
            }) }}
          </p>
        </div>
      </div>

      <div class="flex flex-wrap gap-2">
        <Button type="button" :disabled="llmAssignmentsPending" @click="saveLlmAssignments">
          {{ llmAssignmentsPending ? $t('settings.llmAssignment.saving') : $t('settings.llmAssignment.save') }}
        </Button>
      </div>
    </CardContent>
  </Card>
</template>
