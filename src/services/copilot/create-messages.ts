import consola from "consola"
import { events } from "fetch-event-stream"
import { randomUUID } from "node:crypto"

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
  captureStreamResponseModel,
} from "~/services/telemetry/telemetry"
import {
  buildMessagesHeaders,
  getAnthropicEffortForModel,
  prepareMessagesRequest,
  sendWithSignatureRetry,
  type CreateMessagesOptions,
} from "~/services/copilot/messages-compat"

import { copilotBaseUrl } from "~/lib/providers/api-config"
import { logCopilotRateLimits } from "~/lib/providers/copilot-rate-limit"
import { HTTPError } from "~/lib/http/error"
import { attachPremiumInfo, getPremiumInfoFromHeaders } from "~/lib/logger"
import { setPluginRequestActualModel } from "~/lib/http/request-context"
import { attachResponseHeaders } from "~/lib/response-headers"
import { state } from "~/lib/state"
import {
  createMockRequestContext,
  extractUpstreamTelemetryHeaders,
} from "~/services/telemetry/mock-values"

export type MessagesStream = ReturnType<typeof events>
export type CreateMessagesReturn = AnthropicResponse | MessagesStream

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
  const telemetryContext = createMockRequestContext({
    requestId,
    model: payload.model,
    sessionId: options.sessionId,
  })
  trackRequestSent({ context: telemetryContext, modelCallId })

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
  setPluginRequestActualModel(payload.model)

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
        apiType: "messages",
        durationMs: Date.now() - start,
        statusCode: error.response.status,
        requestId,
        ...extractUpstreamTelemetryHeaders(error.response.headers),
        modelCallId,
        sampled: telemetryContext.sampled,
        conversationId: telemetryContext.conversationId,
      })
    }
    throw error
  }

  const timeSinceIssuedMs = Date.now() - start
  logCopilotRateLimits(result.headers)

  Object.assign(
    telemetryContext,
    extractUpstreamTelemetryHeaders(result.headers),
  )
  const emitMessagesSuccessTelemetry = (
    options: { finishReason?: string; modelInvoked?: string } = {},
  ) => {
    telemetryContext.modelInvoked = options.modelInvoked
    trackPanelRequest(telemetryContext)
    trackGhostTextShown(telemetryContext)
    scheduleFeedbackEvents(telemetryContext)
    schedulePostResponseEvents(telemetryContext)
    trackResponseSuccess({
      model: payload.model,
      apiType: "messages",
      durationMs: Date.now() - start,
      timeToFirstToken: timeSinceIssuedMs,
      requestId: telemetryContext.requestId,
      modelCallId,
      sampled: telemetryContext.sampled,
      conversationId: telemetryContext.conversationId,
      gitHubRequestId: telemetryContext.gitHubRequestId,
      copilotServiceRequestId: telemetryContext.copilotServiceRequestId,
      gitHubCopilotRequestTe: telemetryContext.gitHubCopilotRequestTe,
      modelInvoked: options.modelInvoked,
      ...(options.finishReason !== undefined ?
        { finishReason: options.finishReason }
      : {}),
    })
  }
  const premium = getPremiumInfoFromHeaders(result.headers)
  if (payload.stream) {
    const stream = (async function* () {
      try {
        for await (const chunk of events(result)) {
          captureStreamResponseModel({
            context: telemetryContext,
            chunk,
            apiType: "messages",
          })
          yield chunk
        }
      } finally {
        emitMessagesSuccessTelemetry({
          finishReason: "stream",
          modelInvoked: telemetryContext.modelInvoked,
        })
      }
    })()
    return attachResponseHeaders(
      attachPremiumInfo(stream, premium),
      result.headers,
    )
  }
  const json = (await result.json()) as AnthropicResponse
  emitMessagesSuccessTelemetry({ modelInvoked: json.model })
  return attachResponseHeaders(attachPremiumInfo(json, premium), result.headers)
}
