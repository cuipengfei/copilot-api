import { app, session } from 'electron'

import type { DesktopProxySettings } from '../src/types/ipc'
import {
  resolveElectronProxyConfigFromSettings,
  type ElectronProxyConfig,
} from './electron-proxy-config'

function isFixedProxyConfig(
  proxyConfig: ElectronProxyConfig,
): proxyConfig is Extract<ElectronProxyConfig, { mode: 'fixed_servers' }> {
  return proxyConfig.mode === 'fixed_servers'
}

export function applyElectronProxyCommandLine(
  proxySettings: DesktopProxySettings,
): boolean {
  const proxyConfig = resolveElectronProxyConfigFromSettings(proxySettings)
  if (proxyConfig.mode === 'direct') {
    app.commandLine.appendSwitch('no-proxy-server')
    console.info('Electron command-line proxy disabled from desktop settings')
    return true
  }

  if (!isFixedProxyConfig(proxyConfig)) return false

  app.commandLine.appendSwitch('proxy-server', proxyConfig.proxyRules)
  if (proxyConfig.proxyBypassRules) {
    app.commandLine.appendSwitch(
      'proxy-bypass-list',
      proxyConfig.proxyBypassRules,
    )
  }

  console.info(
    `Electron command-line proxy configured from desktop settings: ${proxyConfig.proxyRules}`,
  )
  return true
}

export async function applyElectronProxy(
  proxySettings: DesktopProxySettings,
): Promise<void> {
  const proxyConfig = resolveElectronProxyConfigFromSettings(proxySettings)

  try {
    await app.setProxy(proxyConfig)
    await session.defaultSession.setProxy(proxyConfig)
    await session.defaultSession.closeAllConnections()
    await session.defaultSession.forceReloadProxyConfig()
    // electron-updater uses its own non-persistent Chromium session.
    const updateSession = session.fromPartition('electron-updater', {
      cache: false,
    })
    await updateSession.setProxy(proxyConfig)
    await updateSession.closeAllConnections()
    await updateSession.forceReloadProxyConfig()
    const source =
      isFixedProxyConfig(proxyConfig) ?
        `desktop settings: ${proxyConfig.proxyRules}`
      : 'system settings'
    console.info(`Electron proxy configured from ${source}`)
  } catch (error) {
    console.warn('Failed to configure Electron proxy.', error)
  }
}
