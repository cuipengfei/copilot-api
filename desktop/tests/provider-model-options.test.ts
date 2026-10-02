import { describe, expect, test } from 'bun:test'
import { buildProviderModelOptions } from '../electron/provider-model-options'
import {
  mergeProviderModelOptions,
  parseModelSelection,
} from '../src/lib/provider-model-options'

describe('provider model options', () => {
  test('combines configured, selected, builtin and catalog models for disabled providers without credentials', () => {
    const options = buildProviderModelOptions(
      {
        providers: {
          example: {
            enabled: false,
            apiKey: 'secret-key',
            modelsDevProviderId: 'catalog',
            models: { configured: {} },
            codexModels: ['selected', 'configured'],
          },
          copilot: { apiKey: 'another-secret' },
        },
      },
      {
        builtin: () => ['builtin', 'configured'],
        catalog: (name) =>
          name === 'catalog' ? ['catalog-model', 'configured'] : [],
      },
    )
    expect(options).toEqual({
      'github-copilot': ['builtin', 'configured'],
      example: ['builtin', 'catalog-model', 'configured', 'selected'],
    })
    expect(JSON.stringify(options)).not.toContain('secret')
  })
  test('merges builtin Copilot model IDs including namespaced upstream IDs without stealing configured provider aliases', () => {
    expect(
      mergeProviderModelOptions(
        { 'github-copilot': [], custom: [] },
        {
          data: [
            { id: 'gpt-5.4' },
            { id: 'org/family/model' },
            { id: 'custom/model' },
          ],
        },
      ),
    ).toEqual({
      'github-copilot': ['gpt-5.4', 'org/family/model'],
      custom: ['model'],
    })
  })
  test('has empty options for providers without known models', () => {
    expect(
      buildProviderModelOptions(
        { providers: { custom: {} } },
        { builtin: () => [], catalog: () => [] },
      ),
    ).toEqual({ 'github-copilot': [], custom: [] })
  })
  test('merges live model aliases, keeps upstream namespaces and ignores unrelated or invalid models', () => {
    const local = { codex: ['existing'], router: ['manual'] }
    expect(
      mergeProviderModelOptions(local, {
        data: [
          { id: 'codex/new' },
          { id: 'codex/new' },
          { id: 'router/anthropic/claude' },
          { id: 'copilot-model' },
          { id: 'other/model' },
          { id: 'codex/' },
          { id: 123 },
          null,
        ],
      }),
    ).toEqual({
      codex: ['existing', 'new'],
      router: ['anthropic/claude', 'manual'],
    })
    expect(local).toEqual({ codex: ['existing'], router: ['manual'] })
    for (const invalid of [null, {}, { data: 'invalid' }])
      expect(mergeProviderModelOptions(local, invalid)).toEqual(local)
  })
  test('deduplicates manual IDs without dropping namespaced or unknown selections', () => {
    expect(
      parseModelSelection(' vendor/model\r\nnew-model\nvendor/model\n\n'),
    ).toEqual(['vendor/model', 'new-model'])
  })
})
