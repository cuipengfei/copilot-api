import consola from "consola"
import { createHash, randomUUID } from "node:crypto"

import type { SubagentMarker } from "~/lib/http/subagent"
import type { ResponsesStreamChunk } from "~/lib/http/responses-stream-event"
import type {
  CreateResponsesReturn,
  ResponsesPayload,
  ResponsesResult,
  ResponsesStream,
  ResponsesTransport,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import type { PooledWebSocketRequest } from "~/services/responses-websocket"
import type { TelemetryRequestContext } from "~/services/telemetry/types"

import {
  copilotBaseUrl,
  copilotHeaders,
  copilotWebSocketHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "~/lib/providers/api-config"
import { logAutoSessionSelection } from "~/lib/auto-session"
import { COMPACT_REQUEST, type CompactType } from "~/lib/http/compact"
import {
  getUpstreamTransportConfig,
  isOutputEncryptedContentDisabled,
} from "~/lib/config"
import { logCopilotQuotaSnapshots } from "~/lib/providers/copilot-rate-limit"
import { HTTPError } from "~/lib/http/error"
import { attachPremiumInfo, getPremiumInfoFromHeaders } from "~/lib/logger"
import { getResponsesContinuationSession } from "~/lib/responses-continuation"
import { setPluginRequestActualModel } from "~/lib/http/request-context"
import { attachResponseHeaders } from "~/lib/response-headers"
import { resolveInitiatorWithSmartAgent } from "~/lib/smart-agent"
import { state } from "~/lib/state"
import {
  createMockRequestContext,
  extractUpstreamTelemetryHeaders,
} from "~/services/telemetry/mock-values"
import { createWebSocketUrl } from "~/services/responses-websocket"
import { createContinuableResponsesWebSocketStream } from "~/services/responses-websocket-continuation"
import {
  captureStreamResponseModel,
  scheduleFeedbackEvents,
  schedulePostResponseEvents,
  trackRequestSent,
  trackResponseError,
  trackResponseSuccess,
  trackPanelRequest,
  trackGhostTextShown,
} from "~/services/telemetry/telemetry"

import { attachAutoSessionToken } from "~/services/copilot/auto-session-retry"
import { sendResponsesRequestWithReasoningReplay } from "~/services/copilot/responses-compat"
import type { CopilotUsage } from "~/lib/token-usage"

export type { CopilotUsage }

import {
  createResponsesSafeStream,
  decodeResponsesWebSocketChunk,
  encodePoolKeyPart,
  getResponsesStreamTerminalDisposition,
} from "~/services/responses-websocket-helpers"
import { createResponsesHttpEventStream } from "~/services/responses-http"

// Copilot closes the Responses WebSocket with code 1009 (message too big) and
// no terminal event for a message above 32 MiB.
export const COPILOT_RESPONSES_WEBSOCKET_MAX_MESSAGE_BYTES = 32 * 1024 * 1024
const COPILOT_RESPONSES_MIN_OUTPUT_TOKENS = 16

interface ResponsesRequestOptions {
  vision: boolean
  initiator: "agent" | "user"
  subagentMarker?: SubagentMarker | null
  requestId?: string
  sessionId?: string
  compactType?: CompactType
  transport?: ResponsesTransport
  clientSignal?: AbortSignal
  reasoningReplayIdentity?: string
}

export const createResponses = async (
  payload: ResponsesPayload,
  {
    vision,
    initiator,
    subagentMarker,
    requestId: requestedRequestId,
    sessionId,
    compactType,
    transport = "http",
    clientSignal,
    reasoningReplayIdentity,
  }: ResponsesRequestOptions,
): Promise<CreateResponsesReturn> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")
  clientSignal?.throwIfAborted()

  const modelCallId = randomUUID()

  // Determine X-Initiator value
  const { initiator: effectiveInitiator } =
    await resolveInitiatorWithSmartAgent(initiator)

  const headers: Record<string, string> = {
    ...copilotHeaders(state, requestedRequestId, vision),
    "x-initiator": effectiveInitiator,
  }

  prepareInteractionHeaders(sessionId, Boolean(subagentMarker), headers)

  // Extract requestId from already-built headers (do NOT re-generate)
  const requestId = headers["x-request-id"]

  prepareForCompact(headers, compactType)

  const start = Date.now()
  const telemetryContext = createMockRequestContext({
    requestId,
    model: payload.model,
    sessionId,
  })
  trackRequestSent({ context: telemetryContext, modelCallId })

  // service_tier is not supported by github copilot
  payload.service_tier = undefined
  let upstreamPayload = omitUnsupportedCopilotInclude(payload)
  const maxOutputTokens = upstreamPayload.max_output_tokens
  if (
    typeof maxOutputTokens === "number"
    && Number.isInteger(maxOutputTokens)
    && maxOutputTokens > 0
    && maxOutputTokens < COPILOT_RESPONSES_MIN_OUTPUT_TOKENS
  ) {
    upstreamPayload = {
      ...upstreamPayload,
      max_output_tokens: COPILOT_RESPONSES_MIN_OUTPUT_TOKENS,
    }
  }

  consola.debug(`<-- model: ${payload.model}`)

  const effectiveTransport =
    compactType === COMPACT_REQUEST ? "http" : transport

  setPluginRequestActualModel(payload.model)
  if (payload.stream === true && effectiveTransport === "websocket") {
    clientSignal?.throwIfAborted()
    logAutoSessionSelection({
      model: payload.model,
      endpoint: "/responses",
      transport: "websocket",
    })
    const websocketRequest = prepareResponsesWebSocketRequest(
      upstreamPayload,
      headers,
      {
        requestId,
        subagentMarker,
      },
    )
    const stream = createPooledResponsesWebSocketStream(
      websocketRequest,
      clientSignal,
      getResponsesContinuationSession(),
    )
    return stream
  }

  return await createHttpResponses(upstreamPayload, headers, {
    modelCallId,
    start,
    telemetryContext,
    clientSignal,
    reasoningReplayIdentity,
  })
}

const omitUnsupportedCopilotInclude = (
  payload: ResponsesPayload,
): ResponsesPayload => {
  if (
    !payload.include?.includes("output.encrypted_content")
    || !isOutputEncryptedContentDisabled(payload.model)
  ) {
    return payload
  }

  const include = payload.include.filter(
    (item) => item !== "output.encrypted_content",
  )
  const upstreamPayload = { ...payload }
  if (include.length === 0) {
    delete upstreamPayload.include
  } else {
    upstreamPayload.include = include
  }
  return upstreamPayload
}

interface ResponsesHttpContext {
  modelCallId: string
  start: number
  telemetryContext: TelemetryRequestContext
  clientSignal?: AbortSignal
  reasoningReplayIdentity?: string
}

const createHttpResponses = async (
  payload: ResponsesPayload,
  headers: Record<string, string>,
  {
    modelCallId,
    start,
    telemetryContext,
    clientSignal,
    reasoningReplayIdentity,
  }: ResponsesHttpContext,
): Promise<CreateResponsesReturn> => {
  // Discount session tokens only apply to HTTP, never WebSocket requests.
  await attachAutoSessionToken(headers, payload.model, "/responses")
  const url = `${copilotBaseUrl(state)}/responses`
  const transportConfig = getUpstreamTransportConfig()
  const response = await sendResponsesRequestWithReasoningReplay(url, {
    payload,
    headers,
    clientSignal,
    transportConfig,
    reasoningReplayIdentity,
  })
  Object.assign(
    telemetryContext,
    extractUpstreamTelemetryHeaders(response.headers),
  )

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    trackResponseError({
      apiType: "responses",
      model: payload.model,
      durationMs: Date.now() - start,
      statusCode: response.status,
      requestId: telemetryContext.requestId,
      modelCallId,
      sampled: telemetryContext.sampled,
      conversationId: telemetryContext.conversationId,
      gitHubRequestId: telemetryContext.gitHubRequestId,
      copilotServiceRequestId: telemetryContext.copilotServiceRequestId,
      gitHubCopilotRequestTe: telemetryContext.gitHubCopilotRequestTe,
    })
    throw new HTTPError("Failed to create responses", response)
  }

  const timeSinceIssuedMs = Date.now() - start
  const emitResponsesSuccessTelemetry = (options: {
    finishReason: string
    promptTokens?: number
    completionTokens?: number
    bytesReceived?: number
    modelInvoked?: string
  }) => {
    trackPanelRequest(telemetryContext)
    trackGhostTextShown(telemetryContext)
    scheduleFeedbackEvents(telemetryContext)
    schedulePostResponseEvents(telemetryContext)
    trackResponseSuccess({
      apiType: "responses",
      model: payload.model,
      durationMs: Date.now() - start,
      timeToFirstToken: timeSinceIssuedMs,
      requestId: telemetryContext.requestId,
      finishReason: options.finishReason,
      promptTokens: options.promptTokens,
      completionTokens: options.completionTokens,
      bytesReceived: options.bytesReceived,
      modelInvoked: options.modelInvoked,
      modelCallId,
      sampled: telemetryContext.sampled,
      conversationId: telemetryContext.conversationId,
      gitHubRequestId: telemetryContext.gitHubRequestId,
      copilotServiceRequestId: telemetryContext.copilotServiceRequestId,
      gitHubCopilotRequestTe: telemetryContext.gitHubCopilotRequestTe,
    })
  }

  if (payload.stream) {
    const stream = async function* () {
      try {
        for await (const chunk of createResponsesSafeStream(
          createResponsesHttpEventStream(response),
        )) {
          captureStreamResponseModel({
            context: telemetryContext,
            chunk,
            apiType: "responses",
          })
          yield chunk
        }
      } finally {
        emitResponsesSuccessTelemetry({
          finishReason: "stream",
          modelInvoked: telemetryContext.modelInvoked,
        })
      }
    }
    return attachResponseHeaders(
      attachPremiumInfo(stream(), getPremiumInfoFromHeaders(response.headers)),
      response.headers,
    )
  }

  const result = (await response.json()) as ResponsesResult
  const finishReason = result.incomplete_details?.reason ?? "stop"
  const serialized = JSON.stringify(result)
  emitResponsesSuccessTelemetry({
    finishReason,
    promptTokens: result.usage?.input_tokens,
    completionTokens: result.usage?.output_tokens,
    bytesReceived: serialized.length,
    modelInvoked: result.model,
  })
  return attachResponseHeaders(
    attachPremiumInfo(result, getPremiumInfoFromHeaders(response.headers)),
    response.headers,
  )
}

type ResponsesWebSocketPayload = ResponsesPayload & {
  type: "response.create"
  initiator: "agent" | "user"
}

type ResponsesWebSocketRequest =
  PooledWebSocketRequest<ResponsesWebSocketPayload>

export const prepareResponsesWebSocketRequest = (
  payload: ResponsesPayload,
  preparedHeaders: Record<string, string>,
  options: {
    requestId: string
    subagentMarker?: SubagentMarker | null
  },
): ResponsesWebSocketRequest => {
  const initiator = getResponsesWebSocketInitiator(preparedHeaders)

  return {
    headers: copilotWebSocketHeaders(preparedHeaders),
    poolKey: buildResponsesWebSocketPoolKey(payload, options),
    payload: buildResponsesWebSocketPayload(payload, initiator),
    url: buildResponsesWebSocketUrl(copilotBaseUrl(state)),
  }
}

export const buildResponsesWebSocketPoolKey = (
  payload: ResponsesPayload,
  {
    requestId,
    subagentMarker,
  }: {
    requestId: string
    subagentMarker?: SubagentMarker | null
  },
): string => {
  const tokenFingerprint =
    state.copilotToken ?
      createHash("sha256").update(state.copilotToken).digest("hex").slice(0, 16)
    : "missing-token"
  const subagentKey =
    subagentMarker ?
      [
        subagentMarker.session_id,
        subagentMarker.agent_id,
        subagentMarker.agent_type,
      ].join(":")
    : "main"

  return [tokenFingerprint, payload.model, requestId, subagentKey]
    .map(encodePoolKeyPart)
    .join("|")
}

export const getResponsesWebSocketInitiator = (
  preparedHeaders: Record<string, string>,
): "agent" | "user" => {
  const initiator = getHeaderValue(preparedHeaders, "x-initiator")
  return initiator?.toLowerCase() === "agent" ? "agent" : "user"
}

const createPooledResponsesWebSocketStream = (
  request: ResponsesWebSocketRequest,
  clientSignal?: AbortSignal,
  continuationSession?: string,
): ResponsesStream =>
  createResponsesSafeStream(
    createClientPreflightStream(
      createContinuableResponsesWebSocketStream(
        request,
        {
          ...getResponsesWebSocketOptions(),
        },
        {
          sessionId: continuationSession,
          clientSignal,
        },
      ),
      clientSignal,
    ),
  )

const getResponsesWebSocketOptions = () => {
  const transportConfig = getUpstreamTransportConfig()
  return {
    createChunk: createResponsesWebSocketStreamChunk,
    maxBufferedBytes: transportConfig.websocketMaxBufferedBytes,
    maxBufferedMessages: transportConfig.websocketMaxBufferedMessages,
    maxMessageBytes: COPILOT_RESPONSES_WEBSOCKET_MAX_MESSAGE_BYTES,
    getTerminalDisposition: getResponsesStreamTerminalDisposition,
    openErrorMessage: "Failed to create responses websocket",
    openTimeoutMs: transportConfig.websocketOpenTimeoutMs,
    poolIdleTimeoutMs: transportConfig.websocketPoolIdleTimeoutMs,
    streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
    streamErrorMessage:
      "Upstream connection lost, Responses websocket stream error",
    terminalChunkMissingMessage:
      "Responses websocket ended without a terminal response, retry your request.",
  }
}

const createClientPreflightStream = async function* <T>(
  source: AsyncIterable<T>,
  clientSignal?: AbortSignal,
): AsyncGenerator<T, void, unknown> {
  if (clientSignal?.aborted) return
  yield* source
}

export const buildResponsesWebSocketPayload = (
  payload: ResponsesPayload,
  initiator: "agent" | "user",
): ResponsesWebSocketPayload => {
  const websocketPayload: ResponsesWebSocketPayload = {
    ...payload,
    type: "response.create",
    initiator,
  }

  delete websocketPayload.stream
  delete websocketPayload["background"]
  delete websocketPayload.service_tier

  return websocketPayload
}

export const buildResponsesWebSocketUrl = (baseUrl: string): string => {
  return createWebSocketUrl(`${baseUrl.replace(/\/+$/u, "")}/responses`)
}

const getHeaderValue = (
  headers: Record<string, string>,
  headerName: string,
): string | undefined => {
  const normalizedHeaderName = headerName.toLowerCase()
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === normalizedHeaderName,
  )

  return match?.[1]
}

export const createResponsesWebSocketStreamChunk = (
  data: string,
): ResponsesStreamChunk =>
  decodeResponsesWebSocketChunk(data, normalizeCopilotWebSocketEvent)

const normalizeCopilotWebSocketEvent = (
  event: ResponseStreamEvent,
): boolean => {
  if (event.type === "response.completed") {
    logCopilotQuotaSnapshots(event.copilot_quota_snapshots)
  }
  if (event.type !== "error" || !event.error) return false

  consola.warn("Copilot responses websocket stream error:", event.error)
  event.code = event.error.code
  event.message = event.error.message
  return true
}
