import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getAuthStatus: () => ipcRenderer.invoke('auth:get-status'),
  getDeviceCode: () => ipcRenderer.invoke('auth:get-device-code'),
  saveToken: (token: string) => ipcRenderer.invoke('auth:save-token', token),
  checkSavedToken: () => ipcRenderer.invoke('auth:check-saved'),
  configureProvider: (input: unknown) =>
    ipcRenderer.invoke('auth:configure-provider', input),
  startCodexLogin: (callbackUrlOrCode?: string) =>
    ipcRenderer.invoke('auth:start-codex-login', callbackUrlOrCode),
  logout: () => ipcRenderer.invoke('auth:logout'),

  startServer: (port: number, authMode?: string, host?: string) =>
    ipcRenderer.invoke('server:start', port, authMode, host),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  getServerStatus: () => ipcRenderer.invoke('server:get-status'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: unknown) =>
    ipcRenderer.invoke('settings:save', settings),
  getModelMappingsConfig: () => ipcRenderer.invoke('config:get-model-mappings'),
  saveModelMappings: (modelMappings: Record<string, string>) =>
    ipcRenderer.invoke('config:save-model-mappings', modelMappings),

  openUrl: (url: string) => ipcRenderer.invoke('shell:open-url', url),

  fetchUsage: () => ipcRenderer.invoke('server:fetch-usage'),
  fetchModels: () => ipcRenderer.invoke('server:fetch-models'),
  fetchTokenUsage: (period: string) =>
    ipcRenderer.invoke('server:fetch-token-usage', period),
  fetchTokenUsageDaily: (period: string) =>
    ipcRenderer.invoke('server:fetch-token-usage-daily', period),
  fetchTokenUsageEvents: (period: string, page: number, pageSize: number) =>
    ipcRenderer.invoke(
      'server:fetch-token-usage-events',
      period,
      page,
      pageSize,
    ),
  getServerAuthInfo: () => ipcRenderer.invoke('server:get-auth-info'),
  getServerKeys: () => ipcRenderer.invoke('auth:get-server-keys'),
  saveServerKeys: (keys: unknown) =>
    ipcRenderer.invoke('auth:save-server-keys', keys),
  getLogs: () => ipcRenderer.invoke('server:get-logs'),

  onAuthSuccess: (callback: (result: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: unknown) =>
      callback(result)
    ipcRenderer.on('auth:success', handler)
    return () => ipcRenderer.off('auth:success', handler)
  },

  onServerStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) =>
      callback(status)
    ipcRenderer.on('server:status', handler)
    return () => ipcRenderer.off('server:status', handler)
  },

  onServerLog: (callback: (log: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, log: string) =>
      callback(log)
    ipcRenderer.on('server:log', handler)
    return () => ipcRenderer.off('server:log', handler)
  },

  platform: process.platform,
  windowReload: () => ipcRenderer.send('window:reload'),
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximizeToggle: () => ipcRenderer.send('window:maximize-toggle'),
  windowClose: () => ipcRenderer.send('window:close'),
  windowQuit: () => ipcRenderer.send('window:quit'),
  windowZoomIn: () => ipcRenderer.send('window:zoom-in'),
  windowZoomOut: () => ipcRenderer.send('window:zoom-out'),
  windowZoomReset: () => ipcRenderer.send('window:zoom-reset'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowMaximizeChange: (callback: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) =>
      callback(maximized)
    ipcRenderer.on('window:maximize-changed', handler)
    return () => ipcRenderer.off('window:maximize-changed', handler)
  },
})
