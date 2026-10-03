import consola from "consola"

import { getConfig, reloadConfig } from "~/lib/config-store"
import { setupCopilotRuntime } from "~/lib/copilot-runtime"
import { readGitHubToken, readGitHubTokenFromEnv } from "~/lib/credential-store"
import { isGitHubCopilotEnabled } from "~/lib/github-copilot-provider"
import { state } from "~/lib/state"
import { stopCodexRefreshLoop, stopCopilotRefreshLoop } from "~/lib/token"

let pendingReload: Promise<void> = Promise.resolve()

async function applyConfigReload(): Promise<void> {
  const previousConfig = getConfig()
  const wasCopilotEnabled = isGitHubCopilotEnabled(previousConfig)
  const config = reloadConfig()

  if (
    config.providers?.codex?.enabled === false
    || config.providers?.codex?.accountId
      !== previousConfig.providers?.codex?.accountId
  ) {
    consola.debug(
      "Config reload: stopping Codex refresh because its provider is disabled or the selected account changed",
    )
    stopCodexRefreshLoop()
  }
  if (!isGitHubCopilotEnabled(config)) {
    consola.debug(
      "Config reload: Copilot is disabled; stopping its refresh loop",
    )
    stopCopilotRefreshLoop()
    return
  }

  const envToken = readGitHubTokenFromEnv()
  const githubToken =
    state.githubTokenSource === "cli" ?
      state.githubToken
    : (envToken ?? (await readGitHubToken()))

  if (!githubToken) {
    consola.debug(
      "Config reload: no GitHub token is available; clearing Copilot credentials",
    )
    stopCopilotRefreshLoop()
    state.githubToken = undefined
    state.copilotToken = undefined
    state.models = undefined
    state.userName = undefined
    state.copilotApiUrl = undefined
    state.tokenBasedBilling = undefined
    return
  }

  if (
    wasCopilotEnabled
    && githubToken === state.githubToken
    && state.copilotToken
    && state.models
  ) {
    consola.debug(
      "Config reload: GitHub token unchanged and Copilot runtime ready; keeping current credentials",
    )
    return
  }

  stopCopilotRefreshLoop()
  state.copilotToken = undefined
  state.models = undefined
  if (state.githubTokenSource !== "cli") {
    state.githubTokenSource = envToken ? "env" : "file"
  }
  consola.debug(
    `Config reload: initializing Copilot runtime with the ${state.githubTokenSource} GitHub token`,
  )
  await setupCopilotRuntime(githubToken)
  consola.debug("Config reload: Copilot runtime initialized")
}

export function reloadServerConfig(): Promise<void> {
  const reload = pendingReload.then(applyConfigReload)
  pendingReload = reload.catch(() => {})
  return reload
}
