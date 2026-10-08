import consola from "consola"

import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"

import {
  copilotHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "~/lib/api-config"
import {
  getReasoningEffortForModel,
  getUpstreamTransportConfig,
} from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { resolveInitiatorWithSmartAgent } from "~/lib/smart-agent"
import { state } from "~/lib/state"
import { attachAutoSessionToken } from "~/services/copilot/auto-session-retry"
import type { CreateMessagesOptions } from "~/services/copilot/create-messages"
import {
  sendCopilotHttpRequest,
  sendCopilotRequest,
  type CopilotHttpRequestOptions,
} from "~/services/copilot/request"

/**
 * Payload that is actually sent to Copilot's native /v1/messages:
 * top_p stripped and temperature forced to 1, optionally with adaptive
 * thinking config attached.
 */
export type EnhancedMessagesPayload = Omit<
  AnthropicMessagesPayload,
  "top_p"
> & {
  temperature: number
}

export interface PreparedMessagesRequest {
  enhancedPayload: EnhancedMessagesPayload
  adaptiveThinkingEnabled: boolean
  betaHeader: string | undefined
}

/**
 * Check if error response indicates a thinking block issue that can be
 * resolved by stripping thinking blocks and retrying.
 * Matches: invalid signature errors AND "thinking blocks cannot be modified" errors.
 */
export const isThinkingBlockError = (errorBody: unknown): boolean => {
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
export const isInvalidReasoningEffortError = (errorBody: unknown): boolean => {
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
export const parseSupportedEfforts = (errorBody: unknown): Array<string> => {
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
export const stripThinkingBlocks = (
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
export const hasImageContent = (payload: AnthropicMessagesPayload): boolean =>
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

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14"
const ADVANCED_TOOL_USE_BETA = "advanced-tool-use-2025-11-20"
const allowedAnthropicBetas: Record<string, true> = {
  [INTERLEAVED_THINKING_BETA]: true,
  "context-management-2025-06-27": true,
  [ADVANCED_TOOL_USE_BETA]: true,
  "extended-cache-ttl-2025-04-11": true,
}

/**
 * Resolve the anthropic-beta header value based on options and model capabilities.
 * Uses a whitelist to only pass known-safe betas to the Copilot backend.
 */
export interface BuildAnthropicBetaHeaderOptions {
  anthropicBetaHeader: string | undefined
  adaptiveThinkingEnabled: boolean
  thinking: AnthropicMessagesPayload["thinking"]
}

export const buildAnthropicBetaHeader = ({
  anthropicBetaHeader,
  adaptiveThinkingEnabled,
  thinking,
}: BuildAnthropicBetaHeaderOptions): string | undefined => {
  if (anthropicBetaHeader) {
    const filteredBeta = anthropicBetaHeader
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .filter((item) => allowedAnthropicBetas[item] === true)
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
export const reorderAssistantBlocks = (
  payload: AnthropicMessagesPayload,
): void => {
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
export const buildEnhancedPayload = (
  payload: AnthropicMessagesPayload,
  supportsAdaptive: boolean,
): EnhancedMessagesPayload => {
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

export const buildMessagesHeaders = async (
  payload: AnthropicMessagesPayload,
  options: CreateMessagesOptions,
): Promise<Record<string, string>> => {
  const enableVision = hasImageContent(payload)
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

  // 模型命中 Auto 配对且端点适用时附加 Copilot-Session-Token
  await attachAutoSessionToken(headers, payload.model, "/v1/messages")

  return headers
}

export const shouldDisableThinkingForToolChoice = (
  payload: AnthropicMessagesPayload,
): boolean => {
  const toolChoiceType = payload.tool_choice?.type
  return toolChoiceType === "any" || toolChoiceType === "tool"
}

/**
 * Resolve model capabilities and run the local payload pipeline in the
 * original order: beta header resolution, assistant block reorder,
 * enhanced payload build.
 */
export const prepareMessagesRequest = (
  payload: AnthropicMessagesPayload,
  anthropicBetaHeader: string | undefined,
): PreparedMessagesRequest => {
  const selectedModel = state.models?.data.find((m) => m.id === payload.model)
  const supportsAdaptive =
    selectedModel?.capabilities.supports.adaptive_thinking ?? false
  const adaptiveThinkingEnabled =
    supportsAdaptive && !shouldDisableThinkingForToolChoice(payload)

  const betaHeader = buildAnthropicBetaHeader({
    anthropicBetaHeader,
    adaptiveThinkingEnabled,
    thinking: payload.thinking,
  })

  // Reorder assistant blocks: upstream backend requires tool_use at end
  reorderAssistantBlocks(payload)
  const enhancedPayload = buildEnhancedPayload(payload, adaptiveThinkingEnabled)

  return { enhancedPayload, adaptiveThinkingEnabled, betaHeader }
}

export interface SendWithSignatureRetryOptions {
  headers: Record<string, string>
  enhancedPayload: EnhancedMessagesPayload
  clientSignal?: AbortSignal
}

/**
 * Send request to native /v1/messages and handle thinking block error retry.
 */
export const sendWithSignatureRetry = async (
  url: string,
  { headers, enhancedPayload, clientSignal }: SendWithSignatureRetryOptions,
): Promise<Response> => {
  const transportConfig = getUpstreamTransportConfig()
  const requestOptions: CopilotHttpRequestOptions = {
    headers,
    payload: enhancedPayload,
    clientSignal,
    transportConfig: {
      headersTimeoutMs: transportConfig.headersTimeoutMs,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
    },
  }

  // 首次请求链：TLS 单次重试 + Auto 会话令牌失效后单次重试
  const response = await sendCopilotRequest(url, requestOptions)

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
      const retryResponse = await sendCopilotHttpRequest(url, {
        ...requestOptions,
        payload: retryPayload,
      })
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
    const retryResponse = await sendCopilotHttpRequest(url, {
      ...requestOptions,
      payload: strippedPayload,
    })
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
