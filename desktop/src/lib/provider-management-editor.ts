import type {
  ProviderManagementConfig,
  ProviderManagementUpdate,
} from '../types/ipc'

export type ModelSelectionMode = 'auto' | 'selected' | 'none'
export interface ProviderDraft {
  name: string
  type: string
  enabled: boolean
  mode: ModelSelectionMode
  models: string
}

export function createProviderDrafts(
  config: ProviderManagementConfig,
): ProviderDraft[] {
  return config.providers.map((provider) => ({
    name: provider.name,
    type: provider.type,
    enabled: provider.enabled,
    mode:
      provider.agentsModels === undefined ? 'auto'
      : provider.agentsModels.length ? 'selected'
      : 'none',
    models: provider.agentsModels?.join('\n') ?? '',
  }))
}

export function buildProviderManagementUpdate(
  drafts: ProviderDraft[],
  original: ProviderManagementConfig,
): ProviderManagementUpdate {
  const providers: NonNullable<ProviderManagementUpdate['providers']> = {}
  for (const draft of drafts) {
    const previous = original.providers.find(
      (provider) => provider.name === draft.name,
    )
    if (!previous) throw new Error(`Provider '${draft.name}' is not configured`)
    const models = [
      ...new Set(
        draft.models
          .split(/\r?\n/u)
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ]
    if (draft.mode === 'selected' && models.length === 0) {
      throw new Error(`Enter at least one model ID for '${draft.name}'.`)
    }
    const agentsModels =
      draft.mode === 'auto' ? null
      : draft.mode === 'none' ? []
      : models
    const update: NonNullable<ProviderManagementUpdate['providers']>[string] =
      {}
    if (draft.enabled !== previous.enabled) update.enabled = draft.enabled
    if (
      JSON.stringify(agentsModels)
      !== JSON.stringify(previous.agentsModels ?? null)
    ) {
      update.agentsModels = agentsModels
    }
    if (Object.keys(update).length > 0) providers[draft.name] = update
  }
  return {
    ...(Object.keys(providers).length > 0 ? { providers } : {}),
  }
}
