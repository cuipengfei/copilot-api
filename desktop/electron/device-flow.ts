import type { DeviceCodeResponse } from '../../src/services/github/get-device-code'
import type { DesktopSettings } from '../src/types/ipc'

export interface DeviceFlowDependencies {
  getDeviceCode: () => Promise<DeviceCodeResponse>
  pollAccessToken: (
    deviceCode: DeviceCodeResponse,
    signal: AbortSignal,
  ) => Promise<string>
  onToken: (token: string, signal: AbortSignal) => Promise<void>
  onError: (error: Error) => void
}

export interface DeviceFlowTokenDependencies {
  getGitHubUser: (token: string) => Promise<string>
  getCopilotAccountType: (
    token: string,
  ) => Promise<DesktopSettings['accountType']>
  readSettings: () => Promise<DesktopSettings>
  saveToken: (token: string, signal: AbortSignal) => Promise<void>
  writeSettings: (settings: DesktopSettings) => Promise<void>
  onSuccess: () => void
}

export function createDeviceFlowTokenHandler(
  dependencies: DeviceFlowTokenDependencies,
): DeviceFlowDependencies['onToken'] {
  let pendingPersistence = Promise.resolve()

  return async (token, signal) => {
    signal.throwIfAborted()
    const [, accountType] = await Promise.all([
      dependencies.getGitHubUser(token),
      dependencies.getCopilotAccountType(token),
    ])
    signal.throwIfAborted()

    // A file write already in progress cannot be cancelled. Finish it before
    // a newer flow persists, so it cannot overwrite the newer credentials.
    const previousPersistence = pendingPersistence
    const persistence = Promise.withResolvers<void>()
    pendingPersistence = persistence.promise

    try {
      await previousPersistence
      signal.throwIfAborted()
      const settings = await dependencies.readSettings()
      signal.throwIfAborted()
      await dependencies.saveToken(token, signal)
      signal.throwIfAborted()
      await dependencies.writeSettings({ ...settings, accountType })
      signal.throwIfAborted()
      dependencies.onSuccess()
    } finally {
      persistence.resolve()
    }
  }
}

/**
 * Starts GitHub device flows for the sign-in page, one at a time. Starting a
 * new request supersedes pending device-code requests and token polls, so
 * only the current flow can return a code or begin handling a token.
 */
export function createDeviceFlowStarter(
  dependencies: DeviceFlowDependencies,
): () => Promise<DeviceCodeResponse> {
  let active: AbortController | undefined

  return async () => {
    active?.abort()
    const controller = new AbortController()
    active = controller

    try {
      const deviceCode = await dependencies.getDeviceCode()
      controller.signal.throwIfAborted()

      void dependencies
        .pollAccessToken(deviceCode, controller.signal)
        .then((token) => {
          controller.signal.throwIfAborted()
          return dependencies.onToken(token, controller.signal)
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          dependencies.onError(
            error instanceof Error ? error : new Error(String(error)),
          )
        })
        .finally(() => {
          if (active === controller) active = undefined
        })

      return deviceCode
    } catch (error) {
      if (active === controller) active = undefined
      controller.signal.throwIfAborted()
      throw error
    }
  }
}
