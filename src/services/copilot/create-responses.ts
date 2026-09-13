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
import { getAutoSessionTokenForModel } from "~/lib/auto-session"
import { COMPACT_REQUEST, type CompactType } from "~/lib/compact"
import { getUpstreamTransportConfig } from "~/lib/config"
import {
  logCopilotQuotaSnapshots,
  logCopilotRateLimits,
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

import { retryAfterInvalidAutoModeSelector } from "./auto-session-retry"
import { retryAfterTlsCertificateVerificationFailure } from "../tls-retry"
import {
  isReasoningItem,
  normalizeResponsesInputForReplay,
} from "~/routes/responses/utils"
import type { CopilotUsage } from "~/lib/token-usage"

export type { CopilotUsage }

import {
  createResponsesSafeStream,
  encodePoolKeyPart,
  isTerminalResponsesStreamChunk,
} from "~/services/responses-websocket-helpers"
import { createResponsesHttpEventStream } from "~/services/responses-http"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"

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

const attachAutoSessionToken = async (
  headers: Record<string, string>,
  model: string,
): Promise<void> => {
  const autoToken = await getAutoSessionTokenForModel(model)
  if (autoToken) {
    headers["Copilot-Session-Token"] = autoToken
  }
}

export const createResponses = async (
  payload: ResponsesPayload,
  {
    vision,
    initiator,
    subagentMarker,
    requestId,
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
    ...copilotHeaders(state, requestId, vision),
    "x-initiator": effectiveInitiator,
  }

  prepareInteractionHeaders(sessionId, Boolean(subagentMarker), headers)

  // Extract requestId from already-built headers (do NOT re-generate)
  const actualRequestId = headers["x-request-id"]

  prepareForCompact(headers, compactType)
  await attachAutoSessionToken(headers, payload.model)

  const start = Date.now()
  trackRequestSent(
    payload.model,
    state.accountType,
    actualRequestId,
    modelCallId,
  )

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
        requestId: actualRequestId,
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
    actualRequestId,
    modelCallId,
    start,
    clientSignal,
  })
}

interface ResponsesHttpContext {
  actualRequestId: string
  modelCallId: string
  start: number
  clientSignal?: AbortSignal
}

const hasStrippableReasoningItem = (payload: ResponsesPayload): boolean => {
  return (
    Array.isArray(payload.input)
    && payload.input.some(
      (item) => isReasoningItem(item) && item.encrypted_content !== undefined,
    )
  )
}

const getResponseErrorMessage = async (
  response: Response,
): Promise<string | undefined> => {
  try {
    const parsed = JSON.parse(await response.clone().text()) as {
      error?: { message?: unknown }
    }
    return typeof parsed.error?.message === "string" ?
        parsed.error.message
      : undefined
  } catch {
    return undefined
  }
}

const createHttpResponses = async (
  payload: ResponsesPayload,
  headers: Record<string, string>,
  { actualRequestId, modelCallId, start, clientSignal }: ResponsesHttpContext,
): Promise<CreateResponsesReturn> => {
  const url = `${copilotBaseUrl(state)}/responses`
  const transportConfig = getUpstreamTransportConfig()
  const sendRequest = () =>
    retryAfterTlsCertificateVerificationFailure(
      () =>
        fetchUpstreamWithLifecycle(
          url,
          { method: "POST", headers, body: JSON.stringify(payload) },
          {
            clientSignal,
            headersTimeoutMs: transportConfig.headersTimeoutMs,
            streamInactivityTimeoutMs:
              transportConfig.streamInactivityTimeoutMs,
          },
        ),
      { signal: clientSignal },
    )

  let response = await retryAfterInvalidAutoModeSelector(
    await sendRequest(),
    headers,
    payload.model,
    sendRequest,
  )

  logCopilotRateLimits(response.headers)

  if (!response.ok) {
    const errorMessage = await getResponseErrorMessage(response)
    const shouldStripReasoningAndRetry =
      response.status >= 400
      && response.status < 500
      && errorMessage?.includes("belong") === true
      && hasStrippableReasoningItem(payload)

    if (shouldStripReasoningAndRetry) {
      consola.warn(
        `drop thinking block, reason: upstream ${response.status} response mentions "belong" (instance-bound item ID); stripping reasoning.encrypted_content and retrying once`,
      )
      normalizeResponsesInputForReplay(payload)
      response = await sendRequest()
      logCopilotRateLimits(response.headers)
    }
  }

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    trackResponseError({
      model: payload.model,
      durationMs: Date.now() - start,
      statusCode: response.status,
      requestId: actualRequestId,
      modelCallId,
    })
    throw new HTTPError("Failed to create responses", response)
  }

  const timeSinceIssuedMs = Date.now() - start
  trackPanelRequest({
    headerRequestId: actualRequestId,
    apiType: "responses",
    modelCallId,
  })
  trackGhostTextShown({
    headerRequestId: actualRequestId,
    ...(state.sku !== undefined ? { sku: state.sku } : {}),
    timeSinceIssuedMs,
    timeSinceDisplayedMs: 0,
  })

  if (actualRequestId) {
    scheduleFeedbackEvents(actualRequestId)
    schedulePostResponseEvents(actualRequestId, payload.model)
  }

  if (payload.stream) {
    trackResponseSuccess({
      model: payload.model,
      durationMs: Date.now() - start,
      requestId: actualRequestId,
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
    requestId: actualRequestId,
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
    isTerminalChunk: isTerminalResponsesStreamChunk,
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
