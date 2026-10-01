import consola from "consola"
import { createHash, randomUUID } from "node:crypto"

import type { SubagentMarker } from "~/lib/subagent"
import type {
  CreateResponsesReturn,
  ResponsesPayload,
  ResponsesResult,
  ResponsesStream,
  ResponsesTransport,
} from "~/lib/types/responses"
import type { PooledWebSocketRequest } from "~/services/responses-websocket"

import {
  copilotBaseUrl,
  copilotHeaders,
  copilotWebSocketHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "~/lib/api-config"
import { COMPACT_REQUEST, type CompactType } from "~/lib/compact"
import { getUpstreamTransportConfig } from "~/lib/config"
import {
  logCopilotQuotaSnapshots,
  type CopilotQuotaSnapshot,
} from "~/lib/copilot-rate-limit"
import { HTTPError } from "~/lib/error"
import { attachPremiumInfo, getPremiumInfoFromHeaders } from "~/lib/logger"
import { attachResponseHeaders } from "~/lib/response-headers"
import { resolveInitiatorWithSmartAgent } from "~/lib/smart-agent"
import { state } from "~/lib/state"
import {
  createPooledWebSocketStream,
  createWebSocketUrl,
} from "~/services/responses-websocket"
import {
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
  encodePoolKeyPart,
  getResponsesStreamTerminalDisposition,
} from "~/services/responses-websocket-helpers"
import { createResponsesHttpEventStream } from "~/services/responses-http"

interface ResponsesRequestOptions {
  vision: boolean
  initiator: "agent" | "user"
  subagentMarker?: SubagentMarker | null
  requestId?: string
  sessionId?: string
  compactType?: CompactType
  transport?: ResponsesTransport
  clientSignal?: AbortSignal
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
  await attachAutoSessionToken(headers, payload.model)

  const start = Date.now()
  trackRequestSent(payload.model, state.accountType, requestId, modelCallId)

  // service_tier is not supported by github copilot
  payload.service_tier = undefined

  consola.debug(`<-- model: ${payload.model}`)

  const effectiveTransport =
    compactType === COMPACT_REQUEST ? "http" : transport

  if (payload.stream === true && effectiveTransport === "websocket") {
    clientSignal?.throwIfAborted()
    const websocketRequest = prepareResponsesWebSocketRequest(
      payload,
      headers,
      {
        requestId,
        subagentMarker,
      },
    )
    const stream = createPooledResponsesWebSocketStream(
      websocketRequest,
      clientSignal,
    )
    return stream
  }

  return await createHttpResponses(payload, headers, {
    requestId,
    modelCallId,
    start,
    clientSignal,
  })
}

interface ResponsesHttpContext {
  requestId: string
  modelCallId: string
  start: number
  clientSignal?: AbortSignal
}

const createHttpResponses = async (
  payload: ResponsesPayload,
  headers: Record<string, string>,
  { requestId, modelCallId, start, clientSignal }: ResponsesHttpContext,
): Promise<CreateResponsesReturn> => {
  const url = `${copilotBaseUrl(state)}/responses`
  const transportConfig = getUpstreamTransportConfig()
  const response = await sendResponsesRequestWithReasoningReplay(url, {
    payload,
    headers,
    clientSignal,
    transportConfig,
  })

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    trackResponseError({
      model: payload.model,
      durationMs: Date.now() - start,
      statusCode: response.status,
      requestId,
      modelCallId,
    })
    throw new HTTPError("Failed to create responses", response)
  }

  const timeSinceIssuedMs = Date.now() - start
  trackPanelRequest({
    headerRequestId: requestId,
    apiType: "responses",
    modelCallId,
  })
  trackGhostTextShown({
    headerRequestId: requestId,
    ...(state.sku !== undefined ? { sku: state.sku } : {}),
    timeSinceIssuedMs,
    timeSinceDisplayedMs: 0,
  })

  if (requestId) {
    scheduleFeedbackEvents(requestId)
    schedulePostResponseEvents(requestId, payload.model)
  }

  if (payload.stream) {
    trackResponseSuccess({
      model: payload.model,
      durationMs: Date.now() - start,
      requestId,
      finishReason: "stream",
      modelCallId,
    })
    return attachResponseHeaders(
      attachPremiumInfo(
        createResponsesSafeStream(createResponsesHttpEventStream(response)),
        getPremiumInfoFromHeaders(response.headers),
      ),
      response.headers,
    )
  }

  const result = (await response.json()) as ResponsesResult
  const finishReason = result.incomplete_details?.reason ?? "stop"
  const serialized = JSON.stringify(result)
  trackResponseSuccess({
    model: payload.model,
    durationMs: Date.now() - start,
    requestId,
    finishReason,
    promptTokens: result.usage?.input_tokens,
    completionTokens: result.usage?.output_tokens,
    bytesReceived: serialized.length,
    modelCallId,
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
): ResponsesStream =>
  createResponsesSafeStream(
    createClientPreflightStream(
      createPooledWebSocketStream(request, {
        ...getResponsesWebSocketOptions(),
      }),
      clientSignal,
    ),
  )

const getResponsesWebSocketOptions = () => {
  const transportConfig = getUpstreamTransportConfig()
  return {
    createChunk: createResponsesWebSocketStreamChunk,
    maxBufferedBytes: transportConfig.websocketMaxBufferedBytes,
    maxBufferedMessages: transportConfig.websocketMaxBufferedMessages,
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

const createResponsesWebSocketStreamChunk = (
  data: string,
): { data?: string; event?: string; id?: string } => {
  if (data === "[DONE]") {
    return { data }
  }

  try {
    const parsed = JSON.parse(data) as {
      copilot_quota_snapshots?: Record<string, CopilotQuotaSnapshot>
      id?: unknown
      type?: unknown
      error?: {
        code: string | null
        message: string
      }
      code?: string | null
      message?: string
    }
    if (parsed.type === "response.completed") {
      logCopilotQuotaSnapshots(parsed.copilot_quota_snapshots)
    }
    if (parsed.type === "error" && parsed.error) {
      consola.warn("Copilot responses websocket stream error:", parsed.error)
      parsed.code = parsed.error.code
      parsed.message = parsed.error.message
    }
    return {
      event: typeof parsed.type === "string" ? parsed.type : undefined,
      data: JSON.stringify(parsed),
      id: typeof parsed.id === "string" ? parsed.id : undefined,
    }
  } catch {
    return { data }
  }
}
