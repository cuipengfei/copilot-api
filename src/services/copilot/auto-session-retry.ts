import consola from "consola"

import {
  getAutoSessionForModel,
  invalidateAutoSessionPairing,
  type AutoSessionSelection,
  type AutoSessionSource,
} from "~/lib/auto-session"
import { state } from "~/lib/state"

interface RequestContext {
  authorizationToken: string
  githubToken: string | undefined
  copilotToken: string | undefined
  selection?: AutoSessionSelection
}

const requests = new WeakMap<Record<string, string>, RequestContext>()

const getAuthToken = (headers: Record<string, string>): string => {
  for (const name in headers) {
    if (name.toLowerCase() === "authorization") {
      return /^Bearer\s+(.+)$/i.exec(headers[name])?.[1] ?? ""
    }
  }
  return ""
}

const getSelectionAuthToken = (
  headers: Record<string, string>,
  context: RequestContext,
): string => {
  const { authorizationToken, githubToken, copilotToken } = context
  if (
    authorizationToken !== ""
    && getAuthToken(headers) === authorizationToken
    && githubToken === state.githubToken
    && copilotToken === state.copilotToken
    && (authorizationToken === copilotToken
      || authorizationToken === githubToken)
  ) {
    return copilotToken ?? ""
  }
  return ""
}

const isTokenRejectionStatus = (status: number): boolean =>
  status === 400 || status === 401

export const getResponseErrorMessage = async (
  response: Response,
): Promise<string | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await response.clone().text())
    if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) {
      return undefined
    }
    const error = parsed.error
    if (typeof error !== "object" || error === null || !("message" in error)) {
      return undefined
    }
    return typeof error.message === "string" ? error.message : undefined
  } catch {
    return undefined
  }
}

export const attachAutoSessionToken = async (
  headers: Record<string, string>,
  model: string,
  endpoint: string,
): Promise<void> => {
  // Messages proxy uses GitHub auth; retain its Copilot association for this request only.
  const context: RequestContext = requests.get(headers) ?? {
    authorizationToken: getAuthToken(headers),
    githubToken: state.githubToken,
    copilotToken: state.copilotToken,
  }
  requests.set(headers, context)
  const selection = await getAutoSessionForModel({
    model,
    endpoint,
    authToken: getSelectionAuthToken(headers, context),
  })
  for (const name in headers) {
    if (name.toLowerCase() === "copilot-session-token") delete headers[name]
  }
  context.selection =
    getSelectionAuthToken(headers, context) ? selection : undefined
  if (context.selection) {
    headers["Copilot-Session-Token"] = context.selection.sessionToken
  }
}

// Each HTTP chain tries a source at most once; connection-bound errors remain
// the caller's compatibility retry, and background discovery never blocks fallback.
export const retryAfterAutoSessionTokenRejection = async (
  response: Response,
  headers: Record<string, string>,
  model: string,
  endpoint: string,
  retry: () => Promise<Response>,
): Promise<Response> => {
  const context = requests.get(headers)
  if (context === undefined) return response
  const excludedSources = new Set<AutoSessionSource>()
  let selection = context.selection
  // An Auto-first chain already skipped Fusion; do not upgrade mid-request.
  if (selection?.source === "auto") excludedSources.add("fusion")
  while (
    selection !== undefined
    && headers["Copilot-Session-Token"] === selection.sessionToken
    && isTokenRejectionStatus(response.status)
  ) {
    const errorMessage = await getResponseErrorMessage(response)
    if (errorMessage?.toLowerCase().includes("belong")) return response
    if (
      response.status === 400
      && !(
        errorMessage !== undefined
        && /(?:session[\s_-]*token|copilot[\s_-]*session)/i.test(errorMessage)
        && /(?:invalid|expired|rejected|mismatch|not valid|not accepted)/i.test(
          errorMessage,
        )
      )
    )
      return response

    excludedSources.add(selection.source)
    if (getSelectionAuthToken(headers, context)) {
      invalidateAutoSessionPairing(model, selection.sessionToken)
    }
    consola.info(
      `[auto-session] rejected model=${JSON.stringify(model)} endpoint=${JSON.stringify(endpoint)} source=${selection.source} expected_discount=${selection.expectedDiscount}% reason=http_${response.status}`,
    )
    delete headers["Copilot-Session-Token"]
    context.selection = undefined
    selection = await getAutoSessionForModel({
      model,
      endpoint,
      authToken: getSelectionAuthToken(headers, context),
      excludedSources,
      waitForDiscovery: false,
    })
    selection = getSelectionAuthToken(headers, context) ? selection : undefined
    if (selection) {
      headers["Copilot-Session-Token"] = selection.sessionToken
      context.selection = selection
    }
    response = await retry()
  }
  return response
}
