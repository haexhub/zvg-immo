<script setup lang="ts">
import { ChevronDown, ChevronUp, X } from 'lucide-vue-next'
import { useSettingsError } from '~/composables/settings/useSettingsError'
import { useLlmProfileOptions, type LlmProviderProfileOption } from '~/composables/settings/useLlmProfileOptions'
import type { LlmChainStrategy, LlmExecutionMode, LlmProviderScope } from '~/server/utils/app-settings'

interface LlmProfilesResponse {
  profiles: LlmProviderProfileOption[]
  assignments: Partial<Record<LlmProviderScope, string[]>>
  strategy: LlmChainStrategy
  effective: Record<LlmProviderScope, {
    provider: string
    baseUrl: string
    model: string
    executionMode: LlmExecutionMode
  }>
  maxChainLength: number
  scopes: LlmProviderScope[]
}

const { t, te } = useI18n()
const { normalizeSettingsError } = useSettingsError()

// extraction/translation are always present; any further scope is an
// insight id (server/utils/insights/registry.ts) — fetched from
// /api/settings/llm-profiles instead of hardcoded, so a newly registered
// insight gets an assignment section automatically.
const LLM_PROVIDER_SCOPES = ref<LlmProviderScope[]>(['extraction', 'translation'])
const ADD_PLACEHOLDER = '__add'
const { llmProfileOptions: llmProfiles, setLlmProfileOptions } = useLlmProfileOptions()
const llmProfileAssignments = reactive<Record<LlmProviderScope, string[]>>({
  extraction: [],
  translation: [],
})
const addSelection = reactive<Record<LlmProviderScope, string>>({
  extraction: ADD_PLACEHOLDER,
  translation: ADD_PLACEHOLDER,
})

function scopeLabel(scope: LlmProviderScope): string {
  if (scope === 'extraction') return t('settings.llmAssignment.extractionTitle')
  if (scope === 'translation') return t('settings.llmAssignment.translationTitle')
  const key = `settings.llm.${scope}Label`
  return te(key) ? t(key) : scope
}

function effectiveFor(scope: LlmProviderScope): { provider: string; baseUrl: string } {
  return llmProfileEffective.value?.[scope] ?? { provider: '', baseUrl: '' }
}
const LLM_CHAIN_STRATEGY_OPTIONS: LlmChainStrategy[] = ['fallback', 'round-robin']
// Only the extraction chain has a strategy: it's the one a background task
// walks hundreds of times per run, so spreading it over several API keys is
// what buys throughput. On-demand translation issues one request at a time.
const chainStrategy = ref<LlmChainStrategy>('fallback')
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

function isRoundRobin(scope: LlmProviderScope): boolean {
  return scope === 'extraction' && chainStrategy.value === 'round-robin'
}

// 'Primär'/'Fallback n' describes the fallback strategy specifically — under
// round-robin there is no primary, every link serves its share, so labelling
// one of them primary would misreport what the task does.
function chainBadge(scope: LlmProviderScope, index: number): string {
  if (isRoundRobin(scope)) return t('settings.llmAssignment.poolMember', { n: index + 1 })
  return index === 0
    ? t('settings.llmAssignment.primary')
    : t('settings.llmAssignment.fallbackN', { n: index })
}

function strategyLabel(option: LlmChainStrategy): string {
  return option === 'round-robin'
    ? t('settings.llmAssignment.strategyRoundRobin')
    : t('settings.llmAssignment.strategyFallback')
}

function strategyHint(): string {
  return chainStrategy.value === 'round-robin'
    ? t('settings.llmAssignment.strategyRoundRobinHint')
    : t('settings.llmAssignment.strategyFallbackHint')
}

function setStrategy(option: LlmChainStrategy): void {
  chainStrategy.value = option
  llmAssignmentsSaved.value = false
}

// LlmProviderScope is an open string type (any insight id qualifies), so
// llmProfileAssignments — keyed by it — can't be a closed Record; every
// access needs a default since TS can no longer guarantee the key exists.
// loadLlmAssignments seeds an entry per scope it knows about, so in practice
// this only ever defaults for a scope that hasn't loaded yet.
function assignmentsFor(scope: LlmProviderScope): string[] {
  return llmProfileAssignments[scope] ??= []
}

function chainLimitReached(scope: LlmProviderScope): boolean {
  return assignmentsFor(scope).length >= maxChainLength.value
}

function availableProfiles(scope: LlmProviderScope): LlmProviderProfileOption[] {
  if (chainLimitReached(scope)) return []
  const assigned = new Set(assignmentsFor(scope))
  return llmProfiles.value.filter((profile) => !assigned.has(profile.id))
}

function addAssignment(scope: LlmProviderScope, id: string): void {
  if (id === ADD_PLACEHOLDER || chainLimitReached(scope)) return
  assignmentsFor(scope).push(id)
  addSelection[scope] = ADD_PLACEHOLDER
  llmAssignmentsSaved.value = false
}

function removeAssignment(scope: LlmProviderScope, index: number): void {
  assignmentsFor(scope).splice(index, 1)
  llmAssignmentsSaved.value = false
}

function moveAssignment(scope: LlmProviderScope, index: number, delta: -1 | 1): void {
  const chain = assignmentsFor(scope)
  const target = index + delta
  if (target < 0 || target >= chain.length) return
  ;[chain[index], chain[target]] = [chain[target]!, chain[index]!]
  llmAssignmentsSaved.value = false
}

async function loadLlmAssignments(): Promise<void> {
  try {
    const res = await $fetch<LlmProfilesResponse>('/api/settings/llm-profiles')
    setLlmProfileOptions(res.profiles)
    LLM_PROVIDER_SCOPES.value = res.scopes
    for (const scope of res.scopes) {
      llmProfileAssignments[scope] = [...(res.assignments[scope] ?? [])]
      addSelection[scope] ??= ADD_PLACEHOLDER
    }
    chainStrategy.value = res.strategy
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
    const assignments: Record<string, string[] | undefined> = {}
    for (const scope of LLM_PROVIDER_SCOPES.value) {
      assignments[scope] = llmProfileAssignments[scope]?.length ? llmProfileAssignments[scope] : undefined
    }
    await $fetch('/api/settings/llm-assignments', {
      method: 'PUT',
      body: { assignments, strategy: chainStrategy.value },
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
          <Label>{{ scopeLabel(scope) }}</Label>

          <template v-if="scope === 'extraction'">
            <Select :model-value="chainStrategy" @update:model-value="(option) => setStrategy(option as LlmChainStrategy)">
              <SelectTrigger class="w-full">
                <SelectValue>{{ strategyLabel(chainStrategy) }}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in LLM_CHAIN_STRATEGY_OPTIONS" :key="option" :value="option">
                  {{ strategyLabel(option) }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">{{ strategyHint() }}</p>
          </template>

          <ul v-if="assignmentsFor(scope).length" class="space-y-1.5">
            <li
              v-for="(profileId, index) in assignmentsFor(scope)"
              :key="profileId"
              class="flex items-center gap-1.5 rounded-md border px-2 py-1.5"
            >
              <Badge variant="outline" class="shrink-0">
                {{ chainBadge(scope, index) }}
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
                :disabled="index === assignmentsFor(scope).length - 1"
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
          <p v-else-if="assignmentsFor(scope).length > 1 && scope !== 'extraction'" class="text-xs text-muted-foreground">
            {{ $t('settings.llmAssignment.fallbackHint') }}
          </p>
          <p v-if="assignmentsFor(scope).length === 0 && llmProfileEffective" class="text-xs text-muted-foreground">
            {{ $t(
              scope === 'translation' ? 'settings.llmAssignment.usingTranslationFallback'
                : scope === 'extraction' ? 'settings.llmAssignment.usingEnvDefault'
                : 'settings.llmAssignment.usingInsightFallback',
              effectiveFor(scope),
            ) }}
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
