import {
  beforeEach,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import type { BrowserWindow } from 'electron'

import * as serverAuth from '../electron/server-auth-config'
import * as settingsStore from '../electron/settings-store'
import * as providerManagement from '../../src/lib/provider-management'
import type { DesktopSettings, ServerKeysConfigUpdate } from '../src/types/ipc'

type IpcHandler = (event: unknown, ...parameters: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()
let running = true
let activeAdminApiKey = 'old-admin'
let keys = { apiKeys: ['old-api'], adminApiKey: 'old-admin' }
let settings: DesktopSettings
let restartError: string | undefined
const startServer = mock((port: number, options?: { host?: string }) => {
  if (restartError) {
    return Promise.resolve({ running: false, error: restartError })
  }
  running = true
  activeAdminApiKey = keys.adminApiKey
  return Promise.resolve({ running: true, port, host: options?.host })
})

await mock.module('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) =>
      handlers.set(channel, handler),
    on: () => {},
  },
  shell: { openExternal: () => Promise.resolve() },
  BrowserWindow: class {},
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  utilityProcess: {},
}))
await mock.module('../electron/server-manager', () => ({
  isRunning: () => running,
  startServer,
  stopServer: () => {
    running = false
    return Promise.resolve()
  },
  getPort: () => 4141,
  getHost: () => '127.0.0.1',
  getServerBaseUrl: () => 'http://127.0.0.1:4141',
  getLogs: () => [],
}))

const { registerIpcHandlers } = await import('../electron/ipc-handlers')
const auth = await import('../electron/auth')
const providerAuth = await import('../electron/provider-auth')

async function invoke(
  channel: string,
  ...parameters: unknown[]
): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Unknown IPC channel: ${channel}`)
  return await handler(undefined, ...parameters)
}

beforeEach(async () => {
  handlers.clear()
  keys = { apiKeys: ['old-api'], adminApiKey: 'old-admin' }
  activeAdminApiKey = keys.adminApiKey
  settings = settingsStore.normalizeSettings({})
  restartError = undefined
  startServer.mockClear()
  spyOn(serverAuth, 'readServerKeysConfig').mockImplementation(() =>
    Promise.resolve(structuredClone(keys)),
  )
  spyOn(serverAuth, 'writeServerKeysConfig').mockImplementation(
    (update: ServerKeysConfigUpdate) => {
      keys = {
        apiKeys: update.apiKeys ?? keys.apiKeys,
        adminApiKey:
          update.adminApiKey === undefined ?
            keys.adminApiKey
          : (update.adminApiKey ?? ''),
      }
      return structuredClone(keys)
    },
  )
  spyOn(settingsStore, 'readSettings').mockImplementation(() =>
    Promise.resolve(structuredClone(settings)),
  )
  spyOn(settingsStore, 'writeSettings').mockImplementation((update) => {
    settings = structuredClone(update)
    return Promise.resolve()
  })
  spyOn(providerManagement, 'saveProviderManagementConfig').mockReturnValue({
    configPath: 'test-config.json',
    providers: [],
  })
  const result = {
    success: true,
    mode: 'provider' as const,
    providers: ['codex'],
  }
  spyOn(providerAuth, 'configureProviderWithAuthStatus').mockResolvedValue(
    result,
  )
  spyOn(providerAuth, 'selectCodexAccountForDesktop').mockResolvedValue(result)
  spyOn(providerAuth, 'removeCodexAccountForDesktop').mockResolvedValue(result)
  spyOn(providerAuth, 'loginCodexForDesktop').mockResolvedValue(result)
  spyOn(auth, 'getGitHubUser').mockResolvedValue('test-user')
  spyOn(auth, 'getCopilotAccountType').mockResolvedValue('individual')
  spyOn(auth, 'saveToken').mockResolvedValue(undefined)
  spyOn(auth, 'clearToken').mockResolvedValue(undefined)
  spyOn(auth, 'readToken').mockResolvedValue(null)
  spyOn(providerAuth, 'getEnabledDesktopProviders').mockReturnValue(['codex'])
  const fetchResponse = Object.assign(
    (_input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      const adminApiKey = new Headers(options?.headers).get('x-api-key')
      if (adminApiKey !== activeAdminApiKey) {
        return Promise.resolve(
          Response.json(
            { error: { message: 'Unauthorized' } },
            { status: 401 },
          ),
        )
      }
      keys.adminApiKey ||= 'regenerated-admin'
      activeAdminApiKey = keys.adminApiKey
      return Promise.resolve(Response.json({ reloaded: true }))
    },
    { preconnect: () => {} },
  )
  spyOn(globalThis, 'fetch').mockImplementation(fetchResponse)
  registerIpcHandlers({} as BrowserWindow)
  running = false
  await invoke('config:save-provider-management', {})
  running = true
})

afterEach(() => mock.restore())

describe('desktop saves automatically refresh the running gateway', () => {
  test('remembers the startup key before the first save after an external rotation', async () => {
    await invoke('server:start', 4141, 'provider')
    keys.adminApiKey = 'external-admin'
    await invoke('config:save-provider-management', {})
    expect(activeAdminApiKey).toBe('external-admin')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4141/admin/config/reload',
      expect.objectContaining({ headers: { 'x-api-key': 'old-admin' } }),
    )
  })

  test('remembers the restarted key before another external rotation', async () => {
    await invoke('server:start', 4141, 'provider')
    await invoke('server:stop')
    keys.adminApiKey = 'restarted-admin'
    await invoke('server:start', 4141, 'provider')
    keys.adminApiKey = 'external-admin'
    await invoke('config:save-provider-management', {})
    expect(activeAdminApiKey).toBe('external-admin')
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4141/admin/config/reload',
      expect.objectContaining({ headers: { 'x-api-key': 'restarted-admin' } }),
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('keeps the automatically restarted key when its follow-up refresh fails', async () => {
    await invoke('server:start', 4141, 'provider')
    keys.adminApiKey = 'restarted-admin'
    spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('connection failed'),
    )
    await expect(
      invoke('settings:save', { ...settings, host: '0.0.0.0' }),
    ).rejects.toThrow('refresh failed: connection failed')
    expect(activeAdminApiKey).toBe('restarted-admin')
    keys.adminApiKey = 'external-admin'
    await invoke('config:save-provider-management', {})
    expect(activeAdminApiKey).toBe('external-admin')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('keeps the previous running key when starting another server fails', async () => {
    await invoke('server:start', 4141, 'provider')
    keys.adminApiKey = 'external-admin'
    restartError = 'address unavailable'
    expect(await invoke('server:start', 4142, 'provider')).toEqual({
      running: false,
      error: 'address unavailable',
    })
    await invoke('config:save-provider-management', {})
    expect(activeAdminApiKey).toBe('external-admin')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  const updates: Array<[string, unknown]> = [
    ['config:save-provider-management', {}],
    ['auth:configure-provider', {}],
    ['auth:switch-codex-account', 'account-id'],
    ['auth:remove-codex-account', 'account-id'],
    ['auth:start-codex-login', {}],
    ['auth:save-token', 'github-token'],
    ['auth:logout', undefined],
  ]
  test.each(updates)('refreshes after %s', async (channel, input) => {
    await invoke(channel, input)
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4141/admin/config/reload',
      expect.objectContaining({
        method: 'POST',
        headers: { 'x-api-key': 'old-admin' },
      }),
    )
  })

  test('completes GitHub sign-in when the running service cannot refresh', async () => {
    spyOn(auth, 'getCopilotAccountType').mockResolvedValue('business')
    spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('connection failed'),
    )
    expect(await invoke('auth:save-token', 'github-token')).toEqual({
      success: true,
      mode: 'copilot',
    })
    // The account type is written after the token, so it is only persisted
    // when a failed refresh no longer aborts the sign-in flow.
    expect(settings.accountType).toBe('business')
    expect(activeAdminApiKey).toBe('old-admin')
  })

  test('does not save a cancelled device token waiting behind another credential update', async () => {
    const login =
      Promise.withResolvers<
        Awaited<ReturnType<typeof providerAuth.loginCodexForDesktop>>
      >()
    const loginStarted = Promise.withResolvers<void>()
    const settingsRead = Promise.withResolvers<void>()
    const nextToken = Promise.withResolvers<string>()
    const notifications: string[] = []
    spyOn(providerAuth, 'loginCodexForDesktop').mockImplementation(() => {
      loginStarted.resolve()
      return login.promise
    })
    spyOn(settingsStore, 'readSettings').mockImplementation(() => {
      settingsRead.resolve()
      return Promise.resolve(structuredClone(settings))
    })
    spyOn(auth, 'getDeviceCode').mockResolvedValue({
      device_code: 'device-code',
      user_code: 'CODE',
      verification_uri: 'https://github.com/login/device',
      interval: 5,
      expires_in: 900,
    })
    let polls = 0
    spyOn(auth, 'pollAccessToken').mockImplementation(() =>
      ++polls === 1 ? Promise.resolve('cancelled-token') : nextToken.promise,
    )
    registerIpcHandlers({
      isDestroyed: () => false,
      webContents: { send: (channel: string) => notifications.push(channel) },
    } as unknown as BrowserWindow)
    const pendingLogin = invoke('auth:start-codex-login', {})
    await loginStarted.promise
    await invoke('auth:get-device-code')
    await settingsRead.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(auth.saveToken).not.toHaveBeenCalled()
    await invoke('auth:get-device-code')
    login.resolve({ success: true, mode: 'provider', providers: ['codex'] })
    await pendingLogin
    await invoke('config:save-provider-management', {})
    expect(auth.saveToken).not.toHaveBeenCalled()
    expect(settingsStore.writeSettings).not.toHaveBeenCalled()
    expect(notifications).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)

    nextToken.resolve('current-token')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await invoke('config:save-provider-management', {})
    expect(auth.saveToken).toHaveBeenCalledTimes(1)
    expect(auth.saveToken).toHaveBeenCalledWith('current-token')
    expect(notifications).toEqual(['auth:success'])
  })

  test('rotates keys using the active old admin key', async () => {
    const saved = await invoke('auth:save-server-keys', {
      apiKeys: ['new-api'],
      adminApiKey: 'new-admin',
    })
    expect(saved).toEqual({ apiKeys: ['new-api'], adminApiKey: 'new-admin' })
    expect(activeAdminApiKey).toBe('new-admin')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('returns a regenerated admin key after the user clears it', async () => {
    const saved = await invoke('auth:save-server-keys', { adminApiKey: '' })
    expect(saved).toEqual({
      apiKeys: ['old-api'],
      adminApiKey: 'regenerated-admin',
    })
    expect(activeAdminApiKey).toBe('regenerated-admin')
  })

  test('recovers after a saved key rotation could not refresh the service', async () => {
    spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('connection failed'),
    )
    await expect(
      invoke('auth:save-server-keys', { adminApiKey: 'new-admin' }),
    ).rejects.toThrow(
      'Configuration saved, but refresh failed: connection failed',
    )
    expect(keys.adminApiKey).toBe('new-admin')
    expect(activeAdminApiKey).toBe('old-admin')
    await invoke('auth:save-server-keys', { adminApiKey: 'new-admin' })
    expect(activeAdminApiKey).toBe('new-admin')
  })

  test('retries a saved key when the server has already loaded it', async () => {
    await invoke('config:save-provider-management', {})
    keys.adminApiKey = 'restarted-admin'
    activeAdminApiKey = keys.adminApiKey
    await invoke('config:save-provider-management', {})
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  test('only saves while the service is stopped', async () => {
    running = false
    await invoke('auth:save-server-keys', { adminApiKey: 'new-admin' })
    expect(keys.adminApiKey).toBe('new-admin')
    expect(fetch).not.toHaveBeenCalled()
  })

  test('restarts automatically when a server startup setting changes', async () => {
    await invoke('settings:save', { ...settings, host: '0.0.0.0' })
    expect(startServer).toHaveBeenCalledWith(
      4141,
      expect.objectContaining({ host: '0.0.0.0' }),
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('keeps the running service for desktop-only settings', async () => {
    await invoke('settings:save', { ...settings, theme: 'dark' })
    expect(startServer).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('does not start a stopped service after saving startup settings', async () => {
    running = false
    await invoke('settings:save', { ...settings, host: '0.0.0.0' })
    expect(startServer).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('reports a failed automatic restart', async () => {
    restartError = 'address unavailable'
    await expect(
      invoke('settings:save', { ...settings, host: '0.0.0.0' }),
    ).rejects.toThrow('address unavailable')
  })
})
