import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import ProviderManagementModal from '../src/components/ProviderManagementModal'
import ProviderManagementPanel from '../src/components/ProviderManagementPanel'
import DashboardPage from '../src/pages/DashboardPage'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import type {
  ProviderManagementConfig,
  ProviderManagementUpdate,
  ProviderModelOptions,
} from '../src/types/ipc'

const fixture: ProviderManagementConfig = {
  configPath: 'config.json',
  providers: [
    { name: 'dashscope', type: 'openai-compatible', enabled: true },
    {
      name: 'codex',
      type: 'openai-responses',
      enabled: false,
      codexModels: [],
    },
  ],
}
let win: Window
let root: Root
let container: HTMLDivElement
let getConfig: ReturnType<typeof mock<() => Promise<ProviderManagementConfig>>>
let saveConfig: ReturnType<
  typeof mock<
    (input: ProviderManagementUpdate) => Promise<ProviderManagementConfig>
  >
>
let getModelOptions: ReturnType<
  typeof mock<() => Promise<ProviderModelOptions>>
>
let fetchModels: ReturnType<typeof mock<() => Promise<unknown>>>
const previousGlobals = new Map<string, PropertyDescriptor | undefined>()

beforeEach(async () => {
  win = new Window({ url: 'http://localhost' })
  const globals: Record<string, unknown> = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    Event: win.Event,
    MouseEvent: win.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [name, value] of Object.entries(globals)) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    })
  }
  getConfig = mock(() => Promise.resolve(structuredClone(fixture)))
  saveConfig = mock(() => Promise.resolve(structuredClone(fixture)))
  getModelOptions = mock(() =>
    Promise.resolve({
      dashscope: ['qwen-plus', 'qwen-coder'],
      codex: ['gpt-5.5', 'gpt-6.1-sol'],
    }),
  )
  fetchModels = mock(() =>
    Promise.resolve({ data: [{ id: 'codex/live-model' }] }),
  )
  Object.defineProperty(win, 'electronAPI', {
    configurable: true,
    value: {
      getProviderManagementConfig: getConfig,
      saveProviderManagementConfig: saveConfig,
      getProviderModelOptions: getModelOptions,
      fetchModels,
      getServerStatus: () => Promise.resolve({ running: false }),
      getLogs: () => Promise.resolve([]),
      onServerStatus: () => () => {},
      onServerLog: () => () => {},
      windowIsMaximized: () => Promise.resolve(false),
      onWindowMaximizeChange: () => () => {},
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  await win.happyDOM.close()
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  previousGlobals.clear()
})
async function render(
  props: Partial<Parameters<typeof ProviderManagementModal>[0]> = {},
) {
  await act(async () => {
    root.render(
      createElement(LanguageProvider, {
        children: createElement(ProviderManagementModal, {
          onClose: () => {},
          ...props,
        }),
      }),
    )
  })
}
function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === label,
  )
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}
async function selectMode(label: string) {
  const mode = [
    ...container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ].find((node) => node.firstElementChild?.textContent === label)
  if (!mode) throw new Error(`Missing mode: ${label}`)
  await act(async () => {
    mode.click()
  })
}
async function changeText(
  node: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    const prototype =
      node instanceof HTMLInputElement ?
        HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
describe('provider management UI', () => {
  test('places the Providers tab before Model Mappings and allows management while stopped', async () => {
    await act(async () => {
      root.render(
        createElement(LanguageProvider, {
          children: createElement(DashboardPage, {
            authMode: 'provider',
            defaultPort: 4141,
            defaultHost: '127.0.0.1',
            onChangeAuth: () => {},
          }),
        }),
      )
    })
    const tabs = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ]
    expect(tabs[2].textContent).toBe('Providers')
    expect(tabs[2].disabled).toBe(false)
    expect(tabs[3].textContent?.toLowerCase()).toContain('model mappings')
    expect(tabs[3].disabled).toBe(true)
    await act(async () => {
      tabs[2].click()
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelectorAll('nav button')).toHaveLength(2)
    expect(container.querySelector('h3')?.textContent).toBe('dashscope')
    expect(container.textContent).toContain(
      'Provider enablement applies to all clients and requests.',
    )
    expect(fetchModels).not.toHaveBeenCalled()
    expect(
      [...container.querySelectorAll('button')].filter(
        (node) => node.textContent === 'Providers',
      ),
    ).toHaveLength(1)
  })
  test('renders as a page and preserves edits when switching between providers', async () => {
    await act(async () => {
      root.render(
        createElement(LanguageProvider, {
          children: createElement(ProviderManagementPanel, {}),
        }),
      )
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    await selectMode('Selected models')
    await act(async () => {
      container
        .querySelector<HTMLInputElement>('[aria-label="dashscope: qwen-plus"]')!
        .click()
    })
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('nav button[aria-label="codex"]')!
        .click()
    })
    expect(container.querySelector('h3')?.textContent).toBe('codex')
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('nav button[aria-label="dashscope"]')!
        .click()
    })
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="dashscope: qwen-plus"]',
      )?.checked,
    ).toBe(true)
    await act(async () => {
      button('Save').click()
    })
    expect(saveConfig).toHaveBeenCalledWith({
      providers: { dashscope: { codexModels: ['qwen-plus'] } },
    })
  })
  test('searches and selects discovered models without typing IDs, preserving unknown selections', async () => {
    getConfig.mockImplementation(() =>
      Promise.resolve({
        ...fixture,
        providers: [
          {
            name: 'codex',
            type: 'openai-responses',
            enabled: true,
            codexModels: ['unknown-model'],
          },
        ],
      }),
    )
    await render({ serverRunning: true })
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="codex: unknown-model"]',
      )?.checked,
    ).toBe(true)
    await changeText(container.querySelector('input[type="search"]')!, 'live')
    expect(container.querySelector('[aria-label="codex: gpt-5.5"]')).toBeNull()
    await act(async () => {
      button('Select search results').click()
    })
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="codex: live-model"]',
      )?.checked,
    ).toBe(true)
    await changeText(container.querySelector('input[type="search"]')!, '')
    await act(async () => {
      container
        .querySelector<HTMLInputElement>('[aria-label="codex: gpt-5.5"]')!
        .click()
    })
    await act(async () => {
      button('Save').click()
    })
    expect(saveConfig).toHaveBeenCalledWith({
      providers: {
        codex: { codexModels: ['unknown-model', 'live-model', 'gpt-5.5'] },
      },
    })
  })
  test('offers local models offline and falls back to manual IDs when loading fails', async () => {
    await render()
    expect(fetchModels).not.toHaveBeenCalled()
    await selectMode('Selected models')
    await act(async () => {
      container
        .querySelector<HTMLInputElement>('[aria-label="dashscope: qwen-plus"]')!
        .click()
    })
    expect(container.querySelector('textarea')?.value).toBe('qwen-plus')
    await act(async () => {
      button('Clear selection').click()
    })
    expect(container.querySelector('textarea')?.value).toBe('')
    getModelOptions.mockImplementation(() =>
      Promise.reject(new Error('Model list unavailable')),
    )
    await act(async () => {
      button('Save').click()
    })
    // Switch back to automatic so saving reloads the list without the empty-selection validation.
    await selectMode('Automatic')
    await act(async () => {
      button('Save').click()
    })
    expect(container.textContent).toContain('Could not load the model list')
  })
  test('edits a disabled provider and saves only changes without count or restart controls', async () => {
    await render({ serverRunning: true })
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('nav button[aria-label="codex"]')!
        .click()
    })
    const toggle = container.querySelector<HTMLInputElement>('[role="switch"]')!
    expect(toggle.checked).toBe(false)
    await act(async () => {
      toggle.click()
    })
    await selectMode('Selected models')
    await changeText(
      container.querySelector('textarea')!,
      'gpt-5.5\ngpt-6.1-sol',
    )
    expect(container.querySelector('input[type="number"]')).toBeNull()
    await act(async () => {
      button('Save').click()
    })
    expect(saveConfig).toHaveBeenCalledWith({
      providers: {
        codex: { enabled: true, codexModels: ['gpt-5.5', 'gpt-6.1-sol'] },
      },
    })
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Restart',
    )
    expect(
      [...container.querySelectorAll('button')].some(
        (node) => node.textContent === 'Restart',
      ),
    ).toBe(false)
  })
  test('works offline with no providers and closes from the backdrop', async () => {
    getConfig.mockImplementation(() =>
      Promise.resolve({ ...fixture, providers: [] }),
    )
    const close = mock(() => {})
    await render({ onClose: close })
    expect(container.textContent).toContain('No providers configured')
    await act(async () => {
      button('Save').click()
    })
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Configuration saved.',
    )
    await act(async () => {
      ;(container.firstElementChild as HTMLElement).click()
    })
    expect(close).toHaveBeenCalledTimes(1)
  })
  test('reports load and save failures, and rejects an empty selected list', async () => {
    saveConfig.mockImplementation(() =>
      Promise.reject(new Error('Disk write failed')),
    )
    await render()
    await act(async () => {
      button('Save').click()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Disk write failed',
    )
    await selectMode('Selected models')
    await act(async () => {
      button('Save').click()
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'model ID',
    )
    getConfig.mockImplementation(() => Promise.reject(new Error('Load failed')))
    await act(async () => {
      root.unmount()
    })
    const { createRoot } = await import('react-dom/client')
    root = createRoot(container)
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Load failed',
    )
    expect(button('Save').disabled).toBe(true)
  })
  test('does not close while saving and provides an accessible close button', async () => {
    let resolveSave: ((value: ProviderManagementConfig) => void) | undefined
    saveConfig.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        }),
    )
    const close = mock(() => {})
    await render({
      onClose: close,
      serverRunning: true,
    })
    await act(async () => {
      button('Save').click()
    })
    expect(container.querySelector('fieldset')?.disabled).toBe(true)
    await act(async () => {
      ;(container.firstElementChild as HTMLElement).click()
    })
    expect(close).not.toHaveBeenCalled()
    await act(async () => {
      resolveSave?.(fixture)
    })
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Close"]')!
        .click()
    })
    expect(close).toHaveBeenCalledTimes(1)
  })
})
