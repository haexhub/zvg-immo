<script setup lang="ts">
import { Trash2 } from 'lucide-vue-next'
import { useSettingsError } from '~/composables/settings/useSettingsError'
import { useSettingsTaskOverview } from '~/composables/settings/useSettingsTaskOverview'
import { useLlmProfileOptions } from '~/composables/settings/useLlmProfileOptions'
import type { LlmExecutionMode, LlmProvider } from '~/server/utils/app-settings'

interface LlmProviderProfileForm {
  id: string
  name: string
  provider: LlmProvider
  baseUrl: string
  model: string
  executionMode: LlmExecutionMode
  apiKey: string
  apiKeySet: boolean
  apiKeyMissing: boolean
  clearApiKey: boolean
  modelOptions: { id: string; label: string }[]
  modelOptionsPending: boolean
  modelKeyRequired: boolean
  modelOptionsError: string | null
  modelOptionsRequestId: number
}

// Only the fields this card actually reads. /api/settings/llm-profiles also
// returns assignments/effective/strategy/scopes — those belong to
// SettingsLlmAssignmentsCard, which fetches the same route for itself.
interface LlmProfilesResponse {
  profiles: Array<{
    id: string
    name: string
    provider: LlmProvider
    baseUrl: string
    model: string
    executionMode: LlmExecutionMode
    apiKeySet: boolean
    apiKeyMissing: boolean
  }>
}

const { t } = useI18n()
const { normalizeSettingsError } = useSettingsError()
const { llmBatchJobs, loadLlmBatchJobs } = useSettingsTaskOverview()
const { setLlmProfileOptions } = useLlmProfileOptions()

const LLM_PROVIDER_PRESETS: Record<LlmProvider, { baseUrl: string; model: string }> = {
  'claude-proxy': { baseUrl: 'http://haex-claude-proxy:8080', model: 'claude-sonnet-5' },
  'gemini-native': { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-latest' },
  'openai-compatible': { baseUrl: 'https://api.openai.com/v1', model: '' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: '' },
}

const llmProfiles = ref<LlmProviderProfileForm[]>([])
const persistedLlmProfileIds = ref<Set<string>>(new Set())
const llmProfilesError = ref<string | null>(null)
const llmProfilesSaved = ref(false)
const llmProfilesPending = ref(false)

function isOpenAiBatchBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return url.protocol === 'https:' &&
      url.hostname === 'api.openai.com' &&
      url.pathname.replace(/\/+$/, '') === '/v1'
  } catch {
    return false
  }
}

function localProfileId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

function makeProfileForm(input?: Partial<LlmProviderProfileForm>): LlmProviderProfileForm {
  const preset = LLM_PROVIDER_PRESETS[input?.provider ?? 'gemini-native']
  return {
    id: input?.id ?? localProfileId(),
    name: input?.name ?? '',
    provider: input?.provider ?? 'gemini-native',
    baseUrl: input?.baseUrl ?? preset.baseUrl,
    model: input?.model ?? preset.model,
    executionMode: input?.executionMode ?? 'sync',
    apiKey: '',
    apiKeySet: input?.apiKeySet ?? false,
    apiKeyMissing: input?.apiKeyMissing ?? false,
    clearApiKey: false,
    modelOptions: [],
    modelOptionsPending: false,
    modelKeyRequired: false,
    modelOptionsError: null,
    modelOptionsRequestId: 0,
  }
}

function profileSupportsBatch(profile: LlmProviderProfileForm): boolean {
  return profile.provider === 'gemini-native' ||
    profile.provider === 'claude-proxy' ||
    profile.provider === 'openrouter' ||
    (profile.provider === 'openai-compatible' && isOpenAiBatchBaseUrl(profile.baseUrl))
}

function providerCapability(provider: LlmProvider) {
  return llmBatchJobs.value?.capabilities?.[provider] ?? null
}

function providerBatchBroken(provider: LlmProvider): boolean {
  return providerCapability(provider)?.ok === false
}

function profileCanSelectBatch(profile: LlmProviderProfileForm): boolean {
  if (providerBatchBroken(profile.provider)) return false
  return profile.provider === 'gemini-native' ||
    (
      (profile.provider === 'claude-proxy' ||
        profile.provider === 'openrouter' ||
        (profile.provider === 'openai-compatible' && isOpenAiBatchBaseUrl(profile.baseUrl))) &&
      (profile.apiKeySet || !!profile.apiKey)
    )
}

async function loadProfileModelOptions(profile: LlmProviderProfileForm): Promise<void> {
  const requestId = ++profile.modelOptionsRequestId
  profile.modelOptionsError = null
  profile.modelKeyRequired = false
  if (profile.provider === 'openai-compatible') {
    profile.modelOptions = []
    return
  }
  profile.modelOptionsPending = true
  try {
    const res = await $fetch<{ models: { id: string; label: string }[]; keyRequired?: boolean }>(
      '/api/settings/llm-provider/models',
      {
        method: 'POST',
        body: {
          profileId: profile.id,
          provider: profile.provider,
          baseUrl: profile.baseUrl,
          apiKey: profile.apiKey || undefined,
        },
      },
    )
    if (requestId !== profile.modelOptionsRequestId) return
    profile.modelOptions = res.models
    profile.modelKeyRequired = !!res.keyRequired
  } catch (err) {
    if (requestId !== profile.modelOptionsRequestId) return
    profile.modelOptions = []
    profile.modelOptionsError = normalizeSettingsError(err, t('settings.llmProvider.modelLoadError'))
  } finally {
    if (requestId === profile.modelOptionsRequestId) profile.modelOptionsPending = false
  }
}

async function loadLlmProfiles(): Promise<void> {
  try {
    const res = await $fetch<LlmProfilesResponse>('/api/settings/llm-profiles')
    llmProfiles.value = res.profiles.map((profile) => makeProfileForm(profile))
    setLlmProfileOptions(res.profiles)
    persistedLlmProfileIds.value = new Set(res.profiles.map((profile) => profile.id))
    llmProfilesError.value = null
    await Promise.all(llmProfiles.value.map((profile) => loadProfileModelOptions(profile)))
  } catch (err) {
    llmProfilesError.value = normalizeSettingsError(err, t('settings.llmProvider.loadError'))
  }
}

function addLlmProfile(): void {
  llmProfiles.value.push(makeProfileForm({ name: t('settings.llmProvider.newProfileName') }))
  llmProfilesSaved.value = false
}

async function deleteLlmProfile(profile: LlmProviderProfileForm): Promise<void> {
  if (!persistedLlmProfileIds.value.has(profile.id)) {
    llmProfiles.value = llmProfiles.value.filter((candidate) => candidate.id !== profile.id)
    return
  }
  llmProfilesPending.value = true
  llmProfilesError.value = null
  try {
    await $fetch(`/api/settings/llm-profiles/${profile.id}`, { method: 'DELETE' })
    await loadLlmProfiles()
  } catch (err) {
    llmProfilesError.value = normalizeSettingsError(err, t('settings.llmProvider.deleteError'))
  } finally {
    llmProfilesPending.value = false
  }
}

function onLlmProfileProviderChange(profile: LlmProviderProfileForm): void {
  const preset = LLM_PROVIDER_PRESETS[profile.provider]
  profile.baseUrl = preset.baseUrl
  profile.model = preset.model
  if (!profileSupportsBatch(profile)) profile.executionMode = 'sync'
  void loadProfileModelOptions(profile)
}

async function saveLlmProfileList(): Promise<void> {
  llmProfilesPending.value = true
  llmProfilesError.value = null
  llmProfilesSaved.value = false
  try {
    await $fetch('/api/settings/llm-profiles', {
      method: 'PUT',
      body: {
        profiles: llmProfiles.value.map((profile) => ({
          id: profile.id,
          name: profile.name.trim() || profile.provider,
          provider: profile.provider,
          baseUrl: profile.baseUrl.trim(),
          model: profile.model.trim(),
          executionMode: profile.executionMode === 'batch' && profileCanSelectBatch(profile) ? 'batch' : 'sync',
          ...(profile.clearApiKey ? { apiKey: '' } : profile.apiKey ? { apiKey: profile.apiKey } : {}),
        })),
      },
    })
    await loadLlmProfiles()
    llmProfilesSaved.value = !llmProfilesError.value
  } catch (err) {
    llmProfilesError.value = normalizeSettingsError(err, t('settings.llmProvider.saveError'))
  } finally {
    llmProfilesPending.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadLlmProfiles(), loadLlmBatchJobs()])
})
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ $t('settings.llmProvider.title') }}</CardTitle>
      <CardAction>
        <Button type="button" size="sm" @click="addLlmProfile">{{ $t('settings.llmProvider.addProfile') }}</Button>
      </CardAction>
    </CardHeader>
    <CardContent class="space-y-6">
      <p class="text-sm text-muted-foreground">
        {{ $t('settings.llmProvider.description') }}
      </p>

      <p v-if="llmProfilesError" class="text-sm text-destructive">{{ llmProfilesError }}</p>
      <p v-if="llmProfilesSaved" class="text-sm text-emerald-600 dark:text-emerald-500">{{ $t('settings.llmProvider.saved') }}</p>

      <div class="space-y-4">
        <p v-if="!llmProfiles.length" class="text-sm text-muted-foreground">
          {{ $t('settings.llmProvider.profilesEmpty') }}
        </p>

        <div v-for="profile in llmProfiles" :key="profile.id" class="space-y-3 rounded-md border p-3">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="space-y-1">
              <Label>{{ $t('settings.llmProvider.profileNameLabel') }}</Label>
              <Input v-model="profile.name" />
            </div>
            <div class="space-y-1">
              <Label>{{ $t('settings.llmProvider.providerLabel') }}</Label>
              <Select v-model="profile.provider" @update:model-value="onLlmProfileProviderChange(profile)">
                <SelectTrigger class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude-proxy">{{ $t('settings.llmProvider.providerClaudeProxy') }}</SelectItem>
                  <SelectItem value="gemini-native">{{ $t('settings.llmProvider.providerGeminiNative') }}</SelectItem>
                  <SelectItem value="openai-compatible">{{ $t('settings.llmProvider.providerOpenaiCompatible') }}</SelectItem>
                  <SelectItem value="openrouter">{{ $t('settings.llmProvider.providerOpenrouter') }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1">
              <Label>{{ $t('settings.llmProvider.baseUrlLabel') }}</Label>
              <Input v-model="profile.baseUrl" />
            </div>
            <div class="space-y-1">
              <Label>{{ $t('settings.llmProvider.modelLabel') }}</Label>
              <Input v-if="profile.provider === 'openai-compatible'" v-model="profile.model" />
              <div v-else class="flex gap-2">
                <Select v-model="profile.model" :disabled="profile.modelOptionsPending || !profile.modelOptions.length">
                  <SelectTrigger class="w-full">
                    <SelectValue
                      :placeholder="profile.modelOptionsPending ? $t('settings.llmProvider.modelLoading') : $t('settings.llmProvider.modelSelectPlaceholder')"
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="opt in profile.modelOptions" :key="opt.id" :value="opt.id">{{ opt.label }}</SelectItem>
                  </SelectContent>
                </Select>
                <Button type="button" variant="outline" :disabled="profile.modelOptionsPending" @click="loadProfileModelOptions(profile)">
                  {{ $t('settings.llmProvider.modelRefresh') }}
                </Button>
              </div>
              <p v-if="profile.modelKeyRequired" class="text-xs text-muted-foreground">{{ $t('settings.llmProvider.modelKeyRequired') }}</p>
              <p v-if="profile.modelOptionsError" class="text-xs text-destructive">{{ profile.modelOptionsError }}</p>
            </div>
          </div>

          <div class="space-y-1">
            <Label>{{ $t('settings.llmProvider.executionModeLabel') }}</Label>
            <Select v-model="profile.executionMode">
              <SelectTrigger class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sync">{{ $t('settings.llmProvider.executionModeSync') }}</SelectItem>
                <SelectItem v-if="profileSupportsBatch(profile)" value="batch" :disabled="!profileCanSelectBatch(profile)">
                  {{ $t('settings.llmProvider.executionModeBatch') }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p v-if="!profileSupportsBatch(profile)" class="text-xs text-muted-foreground">
              {{ $t('settings.llmProvider.batchUnsupported') }}
            </p>
            <p v-else-if="providerCapability(profile.provider)?.source === 'config'" class="text-xs text-destructive">
              {{ $t('settings.llmProvider.batchConfigGated') }}
            </p>
            <p v-else-if="providerBatchBroken(profile.provider)" class="text-xs text-destructive">
              {{ $t('settings.llmProvider.batchBroken', { message: providerCapability(profile.provider)?.message ?? '' }) }}
            </p>
            <p
              v-if="profile.provider === 'openrouter' && profile.executionMode === 'batch'"
              class="text-xs text-muted-foreground"
            >
              {{ $t('settings.llmProvider.batchTextOnly') }}
            </p>
          </div>

          <div class="space-y-1">
            <Label>{{ $t('settings.llmProvider.apiKeyLabel') }}</Label>
            <Input
              v-model="profile.apiKey"
              type="password"
              autocomplete="off"
              :placeholder="profile.apiKeySet ? $t('settings.llmProvider.apiKeyPlaceholderSet') : $t('settings.llmProvider.apiKeyPlaceholderUnset')"
            />
            <Label v-if="profile.apiKeySet" class="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox v-model="profile.clearApiKey" />
              {{ $t('settings.llmProvider.apiKeyClearOnSave') }}
            </Label>
            <p v-if="profile.apiKeyMissing && !profile.apiKey.trim()" class="text-xs text-destructive">
              {{ $t('settings.llmProvider.apiKeyMissing') }}
            </p>
          </div>

          <div class="flex justify-end">
            <Button type="button" variant="ghost" class="hover:text-destructive" :disabled="llmProfilesPending" @click="deleteLlmProfile(profile)">
              <Trash2 class="h-4 w-4" />
              {{ $t('settings.llmProvider.removeProfile') }}
            </Button>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap gap-2">
        <Button type="button" :disabled="llmProfilesPending" @click="saveLlmProfileList">
          {{ llmProfilesPending ? $t('settings.llmProvider.saving') : $t('settings.llmProvider.save') }}
        </Button>
      </div>

      <SettingsClaudeFlow v-if="llmProfiles.some((profile) => profile.provider === 'claude-proxy')" />
    </CardContent>
  </Card>
</template>
