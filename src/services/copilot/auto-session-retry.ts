import consola from "consola"

import {
  getAutoSessionTokenForModel,
  invalidateAutoSession,
} from "~/lib/auto-session"

const INVALID_AUTO_MODE_SELECTOR = "Invalid auto-mode selector"

export const isInvalidAutoModeSelectorResponse = async (
  response: Response,
): Promise<boolean> => {
  if (response.status !== 401) {
    return false
  }

  const body = await response
    .clone()
    .text()
    .catch(() => "")

  return body.includes(INVALID_AUTO_MODE_SELECTOR)
}

export const attachAutoSessionToken = async (
  headers: Record<string, string>,
  model: string,
): Promise<void> => {
  const autoToken = await getAutoSessionTokenForModel(model)
  if (autoToken) {
    headers["Copilot-Session-Token"] = autoToken
  }
}

export const retryAfterInvalidAutoModeSelector = async (
  response: Response,
  headers: Record<string, string>,
  model: string,
  retry: () => Promise<Response>,
): Promise<Response> => {
  if (!(await isInvalidAutoModeSelectorResponse(response))) {
    return response
  }

  consola.warn(
    "[auto-session] invalid selector, refreshing session and retrying",
  )
  invalidateAutoSession()
  delete headers["Copilot-Session-Token"]

  await attachAutoSessionToken(headers, model)

  return retry()
}
