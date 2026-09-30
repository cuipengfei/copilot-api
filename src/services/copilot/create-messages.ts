import consola from "consola"
import { events } from "fetch-event-stream"
import { randomUUID } from "node:crypto"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/types/anthropic"

import { copilotBaseUrl, prepareMessageProxyHeaders } from "~/lib/api-config"
import { logCopilotRateLimits } from "~/lib/copilot-rate-limit"
import { HTTPError } from "~/lib/error"
import { attachPremiumInfo, getPremiumInfoFromHeaders } from "~/lib/logger"
import { attachResponseHeaders } from "~/lib/response-headers"
import { state } from "~/lib/state"
import { parseUserIdMetadata } from "~/lib/utils"
import {
  trackRequestSent,
  trackResponseSuccess,
  trackResponseError,
  scheduleFeedbackEvents,
  schedulePostResponseEvents,
  trackPanelRequest,
  trackGhostTextShown,
} from "~/services/telemetry/telemetry"

import {
  buildMessagesHeaders,
  getAnthropicEffortForModel,
  prepareMessagesRequest,
  sendWithSignatureRetry,
} from "~/services/copilot/messages-compat"

export type MessagesStream = ReturnType<typeof events>
export type CreateMessagesReturn = AnthropicResponse | MessagesStream

export interface CreateMessagesOptions {
  clientSignal?: AbortSignal
  initiator?: "user" | "agent"
  subagentMarker?: SubagentMarker | null
  requestId?: string
  sessionId?: string
  compactType?: CompactType
}

export { getAnthropicEffortForModel }

/**
 * Passthrough to Copilot's native /v1/messages endpoint.
 * No payload transformation - direct Anthropic format.
 *
 * Implements Strategy C (error fallback): if signature validation fails,
 * retry with thinking blocks stripped. This preserves request body integrity
 * unless absolutely necessary.
 */
export const createMessages = async (
  payload: AnthropicMessagesPayload,
  anthropicBetaHeader: string | undefined,
  options: CreateMessagesOptions = {},
): Promise<CreateMessagesReturn> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")
  options.clientSignal?.throwIfAborted()

  const modelCallId = randomUUID()
  const headers = await buildMessagesHeaders(payload, options)

  const { safetyIdentifier, sessionId } = parseUserIdMetadata(
    payload.metadata?.user_id,
  )

  // claude-opus-4.8 is excluded: Copilot's upstream WAF returns a generic
  // "Access to this endpoint is forbidden" 403 whenever a request carries
  // the Claude-Code-style user-agent without a `copilot-integration-id`
  // header. The exact same header set is accepted on claude-opus-4.7, so
  // the gate is a model-id rollout gap on Copilot's side. Skipping the
  // rewrite for 4.8 keeps the default Copilot identity
  // (copilot-integration-id: vscode-chat + GitHubCopilotChat UA +
  // conversation-agent intent) in place; that path is 200. Remove this
  // skip once Copilot's upstream accepts the Claude-Code identity on 4.8.
  // Probed 2026-05-29.
  if (safetyIdentifier && sessionId && payload.model !== "claude-opus-4.8") {
    prepareMessageProxyHeaders(headers)
  }

  // Extract requestId from already-built headers (do NOT re-generate)
  const requestId = headers["x-request-id"]

  const start = Date.now()
  trackRequestSent(payload.model, state.accountType, requestId, modelCallId)

  const { enhancedPayload, adaptiveThinkingEnabled, betaHeader } =
    prepareMessagesRequest(payload, anthropicBetaHeader)
  if (betaHeader) {
    headers["anthropic-beta"] = betaHeader
  }

  if (adaptiveThinkingEnabled) {
    consola.debug(
      `Adaptive thinking enabled for ${payload.model}, effort: ${getAnthropicEffortForModel(payload.model)}`,
    )
  }

  consola.debug(`<-- model: ${payload.model}`)
  consola.debug("Native Messages API request:", {
    model: payload.model,
    stream: payload.stream,
  })

  let result: Response
  try {
    result = await sendWithSignatureRetry(
      `${copilotBaseUrl(state)}/v1/messages`,
      {
        headers,
        enhancedPayload,
        clientSignal: options.clientSignal,
      },
    )
  } catch (error) {
    if (error instanceof HTTPError) {
      trackResponseError({
        model: payload.model,
        durationMs: Date.now() - start,
        statusCode: error.response.status,
        requestId,
        modelCallId,
      })
    }
    throw error
  }

  logCopilotRateLimits(result.headers)

  scheduleFeedbackEvents(requestId)
  schedulePostResponseEvents(requestId, payload.model)
  const timeSinceIssuedMs = Date.now() - start
  trackPanelRequest({
    headerRequestId: requestId,
    apiType: "messages",
    modelCallId,
  })
  trackGhostTextShown({
    headerRequestId: requestId,
    ...(state.sku !== undefined ? { sku: state.sku } : {}),
    timeSinceIssuedMs,
    timeSinceDisplayedMs: 0,
  })
  trackResponseSuccess({
    model: payload.model,
    durationMs: timeSinceIssuedMs,
    requestId,
    modelCallId,
  })

  const premium = getPremiumInfoFromHeaders(result.headers)
  if (payload.stream) {
    return attachResponseHeaders(
      attachPremiumInfo(events(result), premium),
      result.headers,
    )
  }
  const json = (await result.json()) as AnthropicResponse
  return attachResponseHeaders(attachPremiumInfo(json, premium), result.headers)
}
