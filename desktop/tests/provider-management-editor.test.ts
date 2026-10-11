import { describe, expect, test } from 'bun:test'
import {
  buildProviderManagementUpdate,
  createProviderDrafts,
} from '../src/lib/provider-management-editor'
import type { ProviderManagementConfig } from '../src/types/ipc'

const config: ProviderManagementConfig = {
  configPath: 'config.json',
  providers: [
    { name: 'auto', type: 'anthropic', enabled: true },
    {
      name: 'selected',
      type: 'openai-compatible',
      enabled: false,
      agentsModels: ['vendor/model'],
    },
    { name: 'none', type: 'openai-responses', enabled: true, agentsModels: [] },
  ],
}
describe('provider management editor', () => {
  test('distinguishes automatic, selected, and hidden modes', () => {
    expect(createProviderDrafts(config).map((draft) => draft.mode)).toEqual([
      'auto',
      'selected',
      'none',
    ])
    expect(
      buildProviderManagementUpdate(createProviderDrafts(config), config),
    ).toEqual({})
  })
  test('submits only changed fields and preserves raw IDs containing slashes', () => {
    const drafts = createProviderDrafts(config)
    drafts[1].enabled = true
    drafts[1].models = ' vendor/model \nmodel-two\nmodel-two'
    expect(buildProviderManagementUpdate(drafts, config)).toEqual({
      providers: {
        selected: {
          enabled: true,
          agentsModels: ['vendor/model', 'model-two'],
        },
      },
    })
    drafts[1].mode = 'auto'
    expect(
      buildProviderManagementUpdate(drafts, config).providers?.selected,
    ).toEqual({ enabled: true, agentsModels: null })
    drafts[0].mode = 'none'
    expect(
      buildProviderManagementUpdate(drafts, config).providers?.auto,
    ).toEqual({ agentsModels: [] })
  })
  test('rejects empty specified lists and stale unknown providers', () => {
    const drafts = createProviderDrafts(config)
    drafts[1].models = ' \n '
    expect(() => buildProviderManagementUpdate(drafts, config)).toThrow(
      'model ID',
    )
    drafts[1].models = 'model'
    drafts[0].name = 'missing'
    expect(() => buildProviderManagementUpdate(drafts, config)).toThrow(
      'not configured',
    )
  })
})
