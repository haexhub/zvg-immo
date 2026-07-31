<script setup lang="ts">
import { ChevronDown, ChevronUp, X } from 'lucide-vue-next'
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
  assignments: Partial<Record<LlmProviderScope, string[]>>
  effective: Record<LlmProviderScope, {
    provider: string
    baseUrl: string
    model: string
    executionMode: LlmExecutionMode
  }>
  maxChainLength: number
}

const { t } = useI18n()
const { normalizeSettingsError } = useSettingsError()

const LLM_PROVIDER_SCOPES: LlmProviderScope[] = ['extraction', 'translation']
const ADD_PLACEHOLDER = '__add'
const llmProfiles = useState<LlmProviderProfileForm[]>('settings:llm-profile-options', () => [])
const llmProfileAssignments = reactive<Record<LlmProviderScope, string[]>>({
  extraction: [],
  translation: [],
})
const addSelection = reactive<Record<LlmProviderScope, string>>({
  extraction: ADD_PLACEHOLDER,
  translation: ADD_PLACEHOLDER,
})
const llmProfileEffective = ref<LlmProfilesResponse['effective'] | null>(null)
// Matches the server's MAX_PROVIDER_CHAIN_LENGTH default until loadLlmAssignments
// resolves; kept in sync so the UI never lets a user add entries the server
// would silently truncate on save.
const maxChainLength = ref(5)
const llmAssignmentsError = ref<string | null>(null)
const llmAssignmentsSaved = ref(false)
const llmAssignmentsPending = ref(false)

function profileLabel(id: string): string {
  const profile = llmProfiles.value.find((candidate) => candidate.id === id)
  return profile ? (profile.name || profile.model) : id
}

function chainLimitReached(scope: LlmProviderScope): boolean {
  return llmProfileAssignments[scope].length >= maxChainLength.value
}

function availableProfiles(scope: LlmProviderScope): LlmProviderProfileForm[] {
  if (chainLimitReached(scope)) return []
  const assigned = new Set(llmProfileAssignments[scope])
  return llmProfiles.value.filter((profile) => !assigned.has(profile.id))
}

function addAssignment(scope: LlmProviderScope, id: string): void {
  if (id === ADD_PLACEHOLDER || chainLimitReached(scope)) return
  llmProfileAssignments[scope].push(id)
  addSelection[scope] = ADD_PLACEHOLDER
  llmAssignmentsSaved.value = false
}

function removeAssignment(scope: LlmProviderScope, index: number): void {
  llmProfileAssignments[scope].splice(index, 1)
  llmAssignmentsSaved.value = false
}

function moveAssignment(scope: LlmProviderScope, index: number, delta: -1 | 1): void {
  const chain = llmProfileAssignments[scope]
  const target = index + delta
  if (target < 0 || target >= chain.length) return
  ;[chain[index], chain[target]] = [chain[target]!, chain[index]!]
  llmAssignmentsSaved.value = false
}

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
    llmProfileAssignments.extraction = [...(res.assignments.extraction ?? [])]
    llmProfileAssignments.translation = [...(res.assignments.translation ?? [])]
    maxChainLength.value = res.maxChainLength
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
          extraction: llmProfileAssignments.extraction.length ? llmProfileAssignments.extraction : undefined,
          translation: llmProfileAssignments.translation.length ? llmProfileAssignments.translation : undefined,
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

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div v-for="scope in LLM_PROVIDER_SCOPES" :key="scope" class="space-y-2">
          <Label>
            {{ scope === 'translation' ? $t('settings.llmAssignment.translationTitle') : $t('settings.llmAssignment.extractionTitle') }}
          </Label>

          <ul v-if="llmProfileAssignments[scope].length" class="space-y-1.5">
            <li
              v-for="(profileId, index) in llmProfileAssignments[scope]"
              :key="profileId"
              class="flex items-center gap-1.5 rounded-md border px-2 py-1.5"
            >
              <Badge variant="outline" class="shrink-0">
                {{ index === 0 ? $t('settings.llmAssignment.primary') : $t('settings.llmAssignment.fallbackN', { n: index }) }}
              </Badge>
              <span class="min-w-0 flex-1 truncate text-sm">{{ profileLabel(profileId) }}</span>
              <Button
                type="button" variant="ghost" size="icon" class="h-7 w-7 shrink-0"
                :disabled="index === 0"
                :aria-label="$t('settings.llmAssignment.moveUp')"
                @click="moveAssignment(scope, index, -1)"
              >
                <ChevronUp class="h-4 w-4" />
              </Button>
              <Button
                type="button" variant="ghost" size="icon" class="h-7 w-7 shrink-0"
                :disabled="index === llmProfileAssignments[scope].length - 1"
                :aria-label="$t('settings.llmAssignment.moveDown')"
                @click="moveAssignment(scope, index, 1)"
              >
                <ChevronDown class="h-4 w-4" />
              </Button>
              <Button
                type="button" variant="ghost" size="icon" class="h-7 w-7 shrink-0 hover:text-destructive"
                :aria-label="$t('settings.llmAssignment.remove')"
                @click="removeAssignment(scope, index)"
              >
                <X class="h-4 w-4" />
              </Button>
            </li>
          </ul>
          <p v-else class="text-xs text-muted-foreground">{{ $t('settings.llmAssignment.noProfileAssigned') }}</p>

          <Select
            :model-value="addSelection[scope]"
            :disabled="!availableProfiles(scope).length"
            @update:model-value="(id) => addAssignment(scope, id as string)"
          >
            <SelectTrigger class="w-full">
              <SelectValue :placeholder="$t('settings.llmAssignment.addFallback')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="ADD_PLACEHOLDER" disabled>{{ $t('settings.llmAssignment.addFallback') }}</SelectItem>
              <SelectItem v-for="profile in availableProfiles(scope)" :key="profile.id" :value="profile.id">
                {{ profile.name || profile.model }}
              </SelectItem>
            </SelectContent>
          </Select>

          <p v-if="chainLimitReached(scope)" class="text-xs text-muted-foreground">
            {{ $t('settings.llmAssignment.chainLimitReached', { max: maxChainLength }) }}
          </p>
          <p v-else-if="llmProfileAssignments[scope].length > 1" class="text-xs text-muted-foreground">
            {{ $t('settings.llmAssignment.fallbackHint') }}
          </p>
          <p v-if="llmProfileAssignments[scope].length === 0 && llmProfileEffective" class="text-xs text-muted-foreground">
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
