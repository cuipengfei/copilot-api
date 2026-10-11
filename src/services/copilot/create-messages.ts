import consola from "consola"
import { events } from "fetch-event-stream"
import { randomUUID } from "node:crypto"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/lib/types/anthropic"

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

import { copilotBaseUrl } from "~/lib/api-config"
import { logCopilotRateLimits } from "~/lib/copilot-rate-limit"
import { HTTPError } from "~/lib/error"
import { attachPremiumInfo, getPremiumInfoFromHeaders } from "~/lib/logger"
import { attachResponseHeaders } from "~/lib/response-headers"
import { state } from "~/lib/state"

export type MessagesStream = ReturnType<typeof events>
export type CreateMessagesReturn = AnthropicResponse | MessagesStream

export interface CreateMessagesOptions {
  anthropicVersionHeader?: string
  clientSignal?: AbortSignal
  initiator?: "user" | "agent"
  subagentMarker?: SubagentMarker | null
  requestId?: string
  sessionId?: string
  compactType?: CompactType
}

export { getAnthropicEffortForModel }

/**
 * Send Anthropic messages through Copilot's native /v1/messages endpoint.
 * Shared compatibility preparation preserves thinking blocks and applies
 * model capabilities, payload parameters, and protocol-specific retries.
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

  // Use the final upstream request ID for telemetry.
  const requestId = headers["X-Request-Id"] ?? headers["x-request-id"]

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
