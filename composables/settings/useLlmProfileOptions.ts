import type { LlmExecutionMode, LlmProvider } from '~/server/utils/app-settings'

export interface LlmProviderProfileOption {
  id: string
  name: string
  provider: LlmProvider
  baseUrl: string
  model: string
  executionMode: LlmExecutionMode
}

// Shared across SettingsLlmProfilesCard (owns the full profile CRUD) and
// SettingsLlmAssignmentsCard (only needs this slim projection to build
// provider chains) — both used to independently re-derive the same
// useState key and field list by hand, which could silently drift if either
// side's shape changed without the other noticing.
export function useLlmProfileOptions() {
  const llmProfileOptions = useState<LlmProviderProfileOption[]>('settings:llm-profile-options', () => [])

  function setLlmProfileOptions(profiles: LlmProviderProfileOption[]): void {
    llmProfileOptions.value = profiles.map(({ id, name, provider, baseUrl, model, executionMode }) => ({
      id,
      name,
      provider,
      baseUrl,
      model,
      executionMode,
    }))
  }

  return { llmProfileOptions, setLlmProfileOptions }
}
