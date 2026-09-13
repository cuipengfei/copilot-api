import consola from "consola"
import { events } from "fetch-event-stream"
import { randomUUID } from "node:crypto"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/lib/types/chat-completions"

import {
  copilotBaseUrl,
  copilotHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "~/lib/api-config"
import { getAutoSessionTokenForModel } from "~/lib/auto-session"
import { getUpstreamTransportConfig } from "~/lib/config"
import { logCopilotRateLimits } from "~/lib/copilot-rate-limit"
import { HTTPError } from "~/lib/error"
import { attachPremiumInfo, getPremiumInfoFromHeaders } from "~/lib/logger"
import { attachResponseHeaders } from "~/lib/response-headers"
import { resolveInitiatorWithSmartAgent } from "~/lib/smart-agent"
import { state } from "~/lib/state"
import {
  trackRequestSent,
  trackResponseSuccess,
  trackResponseError,
  scheduleFeedbackEvents,
  schedulePostResponseEvents,
  trackPanelRequest,
  trackGhostTextShown,
} from "~/services/telemetry/telemetry"

import { retryAfterInvalidAutoModeSelector } from "./auto-session-retry"
import { retryAfterTlsCertificateVerificationFailure } from "../tls-retry"
import type { CopilotUsage } from "~/lib/token-usage"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"

export type { CopilotUsage }

/**
 * Check if error response indicates a thinking block issue that can be
 * resolved by stripping thinking/reasoning fields and retrying.
 * Matches: invalid signature errors AND "thinking blocks cannot be modified" errors.
 */
const isThinkingBlockError = (errorBody: unknown): boolean => {
  if (errorBody === null || errorBody === undefined) return false
  const text =
    typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody)
  const lower = text.toLowerCase()
  return lower.includes("signature") || lower.includes("cannot be modified")
}

/**
 * Strip reasoning fields from assistant messages to avoid signature validation errors.
 * Removes both reasoning_opaque (signature) and reasoning_text (thinking content)
 * since they are paired and Copilot may recreate thinking blocks from reasoning_text.
 */
const stripReasoningFields = (
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload => ({
  ...payload,
  messages: payload.messages.map((msg) => {
    if (msg.role !== "assistant") return msg

    const { reasoning_opaque: _sig, reasoning_text: _text, ...rest } = msg
    return rest
  }),
})

/** Track telemetry for a successful non-streaming response. */
function trackNonStreamSuccess(opts: {
  result: ChatCompletionResponse
  model: string
  start: number
  requestId?: string
  modelCallId?: string
}): void {
  const { result, model, start, requestId, modelCallId } = opts
  const finishReason =
    result.choices.length > 0 ? result.choices[0].finish_reason : "stop"
  const serialized = JSON.stringify(result)
  trackResponseSuccess({
    model,
    durationMs: Date.now() - start,
    requestId,
    modelCallId,
    finishReason,
    promptTokens: result.usage?.prompt_tokens,
    completionTokens: result.usage?.completion_tokens,
    bytesReceived: serialized.length,
  })
}

/** Handle a successful Copilot response, returning stream events or parsed JSON. */
async function handleOkResponse(
  response: Response,
  payload: ChatCompletionsPayload,
  opts: { start: number; requestId?: string; modelCallId?: string },
) {
  const premium = getPremiumInfoFromHeaders(response.headers)
  if (opts.requestId) {
    scheduleFeedbackEvents(opts.requestId)
    schedulePostResponseEvents(opts.requestId, payload.model)
  }
  if (payload.stream) {
    trackResponseSuccess({
      model: payload.model,
      durationMs: Date.now() - opts.start,
      requestId: opts.requestId,
      modelCallId: opts.modelCallId,
      finishReason: "stream",
    })
    return attachResponseHeaders(
      attachPremiumInfo(events(response), premium),
      response.headers,
    )
  }
  const result = (await response.json()) as ChatCompletionResponse
  trackNonStreamSuccess({
    result,
    model: payload.model,
    start: opts.start,
    requestId: opts.requestId,
    modelCallId: opts.modelCallId,
  })
  return attachResponseHeaders(
    attachPremiumInfo(result, premium),
    response.headers,
  )
}

function trackSuccessUiTelemetry(opts: {
  requestId?: string
  modelCallId: string
  start: number
}): void {
  const timeSinceIssuedMs = Date.now() - opts.start

  trackPanelRequest({
    headerRequestId: opts.requestId,
    apiType: "chat_completions",
    modelCallId: opts.modelCallId,
  })
  trackGhostTextShown({
    headerRequestId: opts.requestId,
    ...(state.sku !== undefined ? { sku: state.sku } : {}),
    timeSinceIssuedMs,
    timeSinceDisplayedMs: 0,
  })
}

/** Retry the request with reasoning fields stripped after a thinking block error. */
async function retryWithStrippedReasoningFields(
  payload: ChatCompletionsPayload,
  headers: Record<string, string>,
  opts: {
    start: number
    requestId?: string
    modelCallId: string
    clientSignal?: AbortSignal
  },
) {
  consola.warn(
    "Thinking block error detected, retrying with reasoning fields stripped",
  )
  const strippedPayload = stripReasoningFields(payload)
  const transportConfig = getUpstreamTransportConfig()
  const retryResponse = await retryAfterTlsCertificateVerificationFailure(
    () =>
      fetchUpstreamWithLifecycle(
        `${copilotBaseUrl(state)}/chat/completions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(strippedPayload),
        },
        {
          clientSignal: opts.clientSignal,
          headersTimeoutMs: transportConfig.headersTimeoutMs,
          streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
        },
      ),
    { signal: opts.clientSignal },
  )
  if (!retryResponse.ok) {
    consola.error("Retry also failed", retryResponse.status)
    trackResponseError({
      model: payload.model,
      durationMs: Date.now() - opts.start,
      statusCode: retryResponse.status,
      requestId: opts.requestId,
      modelCallId: opts.modelCallId,
    })
    throw new HTTPError(
      "Failed to create chat completions (after retry)",
      retryResponse,
    )
  }

  trackSuccessUiTelemetry({
    requestId: opts.requestId,
    modelCallId: opts.modelCallId,
    start: opts.start,
  })
  return handleOkResponse(retryResponse, payload, opts)
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  options?: {
    clientSignal?: AbortSignal
    subagentMarker?: SubagentMarker | null
    requestId?: string
    sessionId?: string
    compactType?: CompactType
  },
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")
  options?.clientSignal?.throwIfAborted()

  const modelCallId = randomUUID()

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check: only the last message determines initiator
  const lastMessage = payload.messages.at(-1)
  const isAgentCall =
    lastMessage !== undefined
    && ["assistant", "tool"].includes(lastMessage.role)

  // Determine x-initiator value
  const dynamicInitiator = isAgentCall ? "agent" : "user"
  const { initiator } = await resolveInitiatorWithSmartAgent(dynamicInitiator)

  // Build headers and add x-initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, options?.requestId, enableVision),
    "x-initiator": initiator,
  }

  if (options?.sessionId || options?.subagentMarker) {
    prepareInteractionHeaders(
      options.sessionId,
      Boolean(options.subagentMarker),
      headers,
    )
  }

  // Extract requestId from already-built headers (do NOT re-generate)
  const requestId = headers["x-request-id"]

  prepareForCompact(headers, options?.compactType)
  // 模型命中 Auto 覆盖集合时附加 Copilot-Session-Token
  const autoToken = await getAutoSessionTokenForModel(payload.model)
  if (autoToken) {
    headers["Copilot-Session-Token"] = autoToken
  }

  const start = Date.now()
  trackRequestSent(payload.model, state.accountType, requestId, modelCallId)

  // First attempt: passthrough unchanged
  consola.debug(`<-- model: ${payload.model}`)
  const url = `${copilotBaseUrl(state)}/chat/completions`
  const transportConfig = getUpstreamTransportConfig()
  const sendRequest = () =>
    retryAfterTlsCertificateVerificationFailure(
      () =>
        fetchUpstreamWithLifecycle(
          url,
          {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          },
          {
            clientSignal: options?.clientSignal,
            headersTimeoutMs: transportConfig.headersTimeoutMs,
            streamInactivityTimeoutMs:
              transportConfig.streamInactivityTimeoutMs,
          },
        ),
      { signal: options?.clientSignal },
    )

  const response = await retryAfterInvalidAutoModeSelector(
    await sendRequest(),
    headers,
    payload.model,
    sendRequest,
  )

  logCopilotRateLimits(response.headers)

  if (response.ok) {
    trackSuccessUiTelemetry({ requestId, modelCallId, start })
    return handleOkResponse(response, payload, {
      start,
      requestId,
      modelCallId,
    })
  }

  // On error, check if it's an invalid signature error
  const errorBody = await response
    .clone()
    .json()
    .catch(() => null)

  if (response.status === 400 && isThinkingBlockError(errorBody)) {
    return retryWithStrippedReasoningFields(payload, headers, {
      start,
      requestId,
      modelCallId,
      clientSignal: options?.clientSignal,
    })
  }

  // Not a signature error, throw original error
  consola.error("Failed to create chat completions", response.status)
  trackResponseError({
    model: payload.model,
    durationMs: Date.now() - start,
    statusCode: response.status,
    requestId,
    modelCallId,
  })
  throw new HTTPError("Failed to create chat completions", response)
}
