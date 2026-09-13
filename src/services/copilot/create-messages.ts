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
  copilotBaseUrl,
  copilotHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
  prepareMessageProxyHeaders,
} from "~/lib/api-config"
import { getAutoSessionTokenForModel } from "~/lib/auto-session"
import {
  getReasoningEffortForModel,
  getUpstreamTransportConfig,
} from "~/lib/config"
import { logCopilotRateLimits } from "~/lib/copilot-rate-limit"
import { HTTPError } from "~/lib/error"
import { attachPremiumInfo, getPremiumInfoFromHeaders } from "~/lib/logger"
import { attachResponseHeaders } from "~/lib/response-headers"
import { resolveInitiatorWithSmartAgent } from "~/lib/smart-agent"
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

import { retryAfterInvalidAutoModeSelector } from "./auto-session-retry"
import { retryAfterTlsCertificateVerificationFailure } from "../tls-retry"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"

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

/**
 * Check if error response indicates a thinking block issue that can be
 * resolved by stripping thinking blocks and retrying.
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
 * Check if error response indicates that the configured reasoning effort
 * is not supported by the target model. Backend signals this with
 * `code: "invalid_reasoning_effort"` and a message listing supported values.
 */
const isInvalidReasoningEffortError = (errorBody: unknown): boolean => {
  if (errorBody === null || errorBody === undefined) return false
  const text =
    typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody)
  return text.includes("invalid_reasoning_effort")
}

/**
 * Parse supported effort values out of the backend error message.
 * Example substring: `supported values: [medium]` or `[low, medium]`.
 * Returns [] if nothing can be parsed.
 */
const parseSupportedEfforts = (errorBody: unknown): Array<string> => {
  if (errorBody === null || errorBody === undefined) return []
  const text =
    typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody)
  const match = /supported values:\s*\[([^\]]*)\]/i.exec(text)
  if (!match) return []
  return match[1]
    .split(",")
    .map((s) => s.trim().replaceAll(/["'\\]/g, ""))
    .filter((s) => s.length > 0)
}

/**
 * Strip thinking blocks from assistant messages to avoid signature validation errors.
 * Only modifies assistant messages that have array content.
 */
const stripThinkingBlocks = (
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload => ({
  ...payload,
  messages: payload.messages.map((msg) => {
    if (msg.role !== "assistant") return msg
    if (typeof msg.content === "string") return msg
    if (!Array.isArray(msg.content)) return msg
    return {
      ...msg,
      content: msg.content.filter((block) => block.type !== "thinking"),
    }
  }),
})

/**
 * Check if payload contains image content (for Copilot-Vision-Request header).
 * Checks both direct image blocks and images inside tool_result blocks.
 */
const hasImageContent = (payload: AnthropicMessagesPayload): boolean =>
  payload.messages.some((msg) => {
    // Only user messages can contain image content
    if (msg.role !== "user") return false
    if (typeof msg.content === "string") return false
    if (!Array.isArray(msg.content)) return false
    return msg.content.some((block) => {
      if (block.type === "image") return true
      if (
        block.type === "tool_result"
        && Array.isArray(block.content)
        && block.content.some((b) => b.type === "image")
      ) {
        return true
      }
      return false
    })
  })

/**
 * Map config reasoning effort to Anthropic adaptive thinking effort level.
 */
export const getAnthropicEffortForModel = (
  model: string,
): "low" | "medium" | "high" | "max" => {
  const reasoningEffort = getReasoningEffortForModel(model)

  if (reasoningEffort === "xhigh") return "max"
  if (reasoningEffort === "none" || reasoningEffort === "minimal") return "low"

  return reasoningEffort
}

/**
 * Resolve the anthropic-beta header value based on options and model capabilities.
 * Uses a whitelist to only pass known-safe betas to the Copilot backend.
 */
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14"
const ADVANCED_TOOL_USE_BETA = "advanced-tool-use-2025-11-20"
const allowedAnthropicBetas = new Set([
  INTERLEAVED_THINKING_BETA,
  "context-management-2025-06-27",
  ADVANCED_TOOL_USE_BETA,
])

const buildAnthropicBetaHeader = (
  anthropicBetaHeader: string | undefined,
  adaptiveThinkingEnabled: boolean,
  thinking: AnthropicMessagesPayload["thinking"],
): string | undefined => {
  if (anthropicBetaHeader) {
    const filteredBeta = anthropicBetaHeader
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .filter((item) => allowedAnthropicBetas.has(item))
    const dedupedBetas = [...new Set(filteredBeta)]
    // Adaptive thinking conflicts with interleaved-thinking beta
    const finalFilteredBetas =
      adaptiveThinkingEnabled ?
        dedupedBetas.filter((item) => item !== INTERLEAVED_THINKING_BETA)
      : dedupedBetas

    // in vscode copilot extension, advanced-tool-use is enabled by default
    // align header with vscode copilot extension
    const uniqueFilteredBetas = [...new Set(finalFilteredBetas)]
    if (uniqueFilteredBetas.length > 0) {
      return uniqueFilteredBetas.join(",")
    }

    return undefined
  }

  if (!adaptiveThinkingEnabled && thinking?.budget_tokens) {
    return INTERLEAVED_THINKING_BETA
  }

  return undefined
}

/**
 * Reorder assistant message content blocks so text comes before tool_use.
 * The upstream backend rejects requests where text blocks follow tool_use blocks
 * in assistant messages, reporting "tool_use without tool_result".
 *
 * CRITICAL: thinking/redacted_thinking blocks must NOT be moved.
 * The upstream backend validates that thinking blocks remain in their original
 * positions — reordering them triggers:
 *   "thinking or redacted_thinking blocks in the latest assistant
 *    message cannot be modified"
 */
const reorderAssistantBlocks = (payload: AnthropicMessagesPayload): void => {
  for (const msg of payload.messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
    // Separate thinking blocks (preserve positions) from reorderable blocks
    const entries = msg.content.map((block, index) => ({
      index,
      isThinking:
        block.type === "thinking" || block.type === "redacted_thinking",
      block,
    }))

    const thinkingEntries = entries.filter((e) => e.isThinking)
    const reorderable = entries.filter((e) => !e.isThinking)

    // Sort only non-thinking blocks: text before tool_use
    reorderable.sort((a, b) => {
      const order: Record<string, number> = { text: 0, tool_use: 1 }
      return (order[a.block.type] ?? 0) - (order[b.block.type] ?? 0)
    })

    // Reconstruct: thinking blocks at original indices, sorted non-thinking fill remaining slots
    const thinkingIndexSet = new Set(thinkingEntries.map((e) => e.index))
    let ri = 0
    const result = msg.content.map((_, i) =>
      thinkingIndexSet.has(i) ? entries[i].block : reorderable[ri++].block,
    )

    msg.content = result
  }
}

/**
 * Build the enhanced payload: strip top_p, force temperature=1,
 * and add adaptive thinking config for capable models.
 */
const buildEnhancedPayload = (
  payload: AnthropicMessagesPayload,
  supportsAdaptive: boolean,
) => {
  const { top_p: _ignoredTopP, ...restPayload } = payload

  return {
    ...restPayload,
    temperature: 1,
    ...(supportsAdaptive && {
      thinking: { type: "adaptive" as const },
      output_config: {
        effort:
          payload.output_config?.effort
          ?? getAnthropicEffortForModel(payload.model),
      },
    }),
  }
}

const buildMessagesHeaders = async (
  payload: AnthropicMessagesPayload,
  options: CreateMessagesOptions,
  enableVision: boolean,
): Promise<Record<string, string>> => {
  const defaultInitiator = options.initiator ?? "user"
  const { initiator } = await resolveInitiatorWithSmartAgent(defaultInitiator)
  const headers: Record<string, string> = {
    ...copilotHeaders(state, options.requestId, enableVision),
    "x-initiator": initiator,
  }

  prepareInteractionHeaders(
    options.sessionId,
    Boolean(options.subagentMarker),
    headers,
  )
  prepareForCompact(headers, options.compactType)

  // 模型命中 Auto 覆盖集合时附加 Copilot-Session-Token
  const autoToken = await getAutoSessionTokenForModel(payload.model)
  if (autoToken) {
    headers["Copilot-Session-Token"] = autoToken
  }

  return headers
}

const shouldDisableThinkingForToolChoice = (
  payload: AnthropicMessagesPayload,
): boolean => {
  const toolChoiceType = payload.tool_choice?.type
  return toolChoiceType === "any" || toolChoiceType === "tool"
}

/**
 * Send request to native /v1/messages and handle thinking block error retry.
 */
const sendWithSignatureRetry = async (
  url: string,
  headers: Record<string, string>,
  enhancedPayload: ReturnType<typeof buildEnhancedPayload>,
  clientSignal?: AbortSignal,
): Promise<Response> => {
  const transportConfig = getUpstreamTransportConfig()
  const sendRequest = () =>
    retryAfterTlsCertificateVerificationFailure(
      () =>
        fetchUpstreamWithLifecycle(
          url,
          {
            method: "POST",
            headers,
            body: JSON.stringify(enhancedPayload),
          },
          {
            clientSignal,
            headersTimeoutMs: transportConfig.headersTimeoutMs,
            streamInactivityTimeoutMs:
              transportConfig.streamInactivityTimeoutMs,
          },
        ),
      { signal: clientSignal },
    )

  const response = await retryAfterInvalidAutoModeSelector(
    await sendRequest(),
    headers,
    enhancedPayload.model,
    sendRequest,
  )

  if (response.ok) return response

  const errorBody = await response
    .clone()
    .json()
    .catch(() => null)

  if (response.status === 400 && isInvalidReasoningEffortError(errorBody)) {
    const supported = parseSupportedEfforts(errorBody)
    const currentEffort = enhancedPayload.output_config?.effort
    const fallbackEffort =
      supported.find((v) => v !== currentEffort) ?? supported[0]
    if (fallbackEffort && enhancedPayload.output_config) {
      consola.warn(
        `invalid_reasoning_effort (current=${currentEffort ?? "<unset>"}), retrying with effort=${fallbackEffort}`,
      )
      const retryPayload = {
        ...enhancedPayload,
        output_config: {
          ...enhancedPayload.output_config,
          effort: fallbackEffort,
        },
      }
      const retryResponse = await retryAfterTlsCertificateVerificationFailure(
        () =>
          fetchUpstreamWithLifecycle(
            url,
            {
              method: "POST",
              headers,
              body: JSON.stringify(retryPayload),
            },
            {
              clientSignal,
              headersTimeoutMs: transportConfig.headersTimeoutMs,
              streamInactivityTimeoutMs:
                transportConfig.streamInactivityTimeoutMs,
            },
          ),
        { signal: clientSignal },
      )
      if (!retryResponse.ok) {
        consola.error(
          "Effort-downgrade retry also failed",
          retryResponse.status,
        )
        throw new HTTPError(
          "Failed to create native messages (after effort retry)",
          retryResponse,
        )
      }
      return retryResponse
    }
    consola.warn(
      "invalid_reasoning_effort detected but no usable supported values parsed from backend",
    )
  }

  if (response.status === 400 && isThinkingBlockError(errorBody)) {
    consola.warn(
      "Thinking block error detected, retrying with thinking blocks stripped",
    )
    const strippedPayload = stripThinkingBlocks(enhancedPayload)
    const retryResponse = await retryAfterTlsCertificateVerificationFailure(
      () =>
        fetchUpstreamWithLifecycle(
          url,
          {
            method: "POST",
            headers,
            body: JSON.stringify(strippedPayload),
          },
          {
            clientSignal,
            headersTimeoutMs: transportConfig.headersTimeoutMs,
            streamInactivityTimeoutMs:
              transportConfig.streamInactivityTimeoutMs,
          },
        ),
      { signal: clientSignal },
    )
    if (!retryResponse.ok) {
      consola.error("Retry also failed", retryResponse.status)
      throw new HTTPError(
        "Failed to create native messages (after retry)",
        retryResponse,
      )
    }
    return retryResponse
  }

  consola.error("Failed to create native messages", response.status)
  throw new HTTPError("Failed to create native messages", response)
}

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
  const enableVision = hasImageContent(payload)
  const headers = await buildMessagesHeaders(payload, options, enableVision)

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

  // Resolve model capabilities and build enhanced payload
  const selectedModel = state.models?.data.find((m) => m.id === payload.model)
  const supportsAdaptive =
    selectedModel?.capabilities.supports.adaptive_thinking ?? false
  const adaptiveThinkingEnabled =
    supportsAdaptive && !shouldDisableThinkingForToolChoice(payload)

  const betaHeader = buildAnthropicBetaHeader(
    anthropicBetaHeader,
    adaptiveThinkingEnabled,
    payload.thinking,
  )
  if (betaHeader) {
    headers["anthropic-beta"] = betaHeader
  }

  // Reorder assistant blocks: upstream backend requires tool_use at end
  reorderAssistantBlocks(payload)

  const enhancedPayload = buildEnhancedPayload(payload, adaptiveThinkingEnabled)

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
      headers,
      enhancedPayload,
      options.clientSignal,
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
