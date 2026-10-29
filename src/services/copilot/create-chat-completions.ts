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
import {
  getReasoningEffortForModel,
  getUpstreamTransportConfig,
} from "~/lib/config"
import { logCopilotRateLimits } from "~/lib/copilot-rate-limit"
import { attachPremiumInfo, getPremiumInfoFromHeaders } from "~/lib/logger"
import { resolveSupportedReasoningEffort } from "~/lib/reasoning-effort"
import { setPluginRequestActualModel } from "~/lib/request-context"
import { attachResponseHeaders } from "~/lib/response-headers"
import { resolveInitiatorWithSmartAgent } from "~/lib/smart-agent"
import { state } from "~/lib/state"
import {
  scheduleFeedbackEvents,
  schedulePostResponseEvents,
  trackRequestSent,
  trackResponseSuccess,
  trackPanelRequest,
  trackGhostTextShown,
} from "~/services/telemetry/telemetry"

import { attachAutoSessionToken } from "~/services/copilot/auto-session-retry"
import { ensureChatCompletionOkResponse } from "~/services/copilot/chat-completions-compat"
import { sendCopilotRequest } from "~/services/copilot/request"

export type { CopilotUsage } from "~/lib/token-usage"

// 显式请求优先；配置默认值按模型声明的能力转换。
export const resolveChatCompletionsReasoningEffort = (
  payload: Pick<ChatCompletionsPayload, "model" | "reasoning_effort">,
): string | undefined => {
  if (payload.reasoning_effort !== undefined) return payload.reasoning_effort

  const supportedEfforts = state.models?.data.find(
    (model) => model.id === payload.model,
  )?.capabilities?.supports?.reasoning_effort
  if (supportedEfforts?.length === 0) return undefined

  return resolveSupportedReasoningEffort(
    getReasoningEffortForModel(payload.model),
    supportedEfforts,
  )
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
  await attachAutoSessionToken(headers, payload.model, "/chat/completions")
  const start = Date.now()
  trackRequestSent(payload.model, state.accountType, requestId, modelCallId)

  consola.debug(`<-- model: ${payload.model}`)
  const url = `${copilotBaseUrl(state)}/chat/completions`
  setPluginRequestActualModel(payload.model)

  const reasoningEffort = resolveChatCompletionsReasoningEffort(payload)
  const upstreamPayload =
    reasoningEffort === payload.reasoning_effort ?
      payload
    : { ...payload, reasoning_effort: reasoningEffort }
  const response = await sendCopilotRequest(url, {
    headers,
    payload: upstreamPayload,
    clientSignal: options?.clientSignal,
    transportConfig: getUpstreamTransportConfig(),
  })
  logCopilotRateLimits(response.headers)

  const okResponse = await ensureChatCompletionOkResponse({
    url,
    response,
    payload: upstreamPayload,
    headers,
    start,
    requestId,
    modelCallId,
    clientSignal: options?.clientSignal,
  })

  const timeSinceIssuedMs = Date.now() - start
  trackPanelRequest({
    headerRequestId: requestId,
    apiType: "chat_completions",
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

  const premium = getPremiumInfoFromHeaders(okResponse.headers)
  if (payload.stream) {
    trackResponseSuccess({
      model: payload.model,
      durationMs: Date.now() - start,
      requestId,
      modelCallId,
      finishReason: "stream",
    })
    return attachResponseHeaders(
      attachPremiumInfo(events(okResponse), premium),
      okResponse.headers,
    )
  }

  const result = (await okResponse.json()) as ChatCompletionResponse
  const finishReason =
    result.choices.length > 0 ? result.choices[0].finish_reason : "stop"
  trackResponseSuccess({
    model: payload.model,
    durationMs: Date.now() - start,
    requestId,
    modelCallId,
    finishReason,
    promptTokens: result.usage?.prompt_tokens,
    completionTokens: result.usage?.completion_tokens,
    bytesReceived: JSON.stringify(result).length,
  })
  return attachResponseHeaders(
    attachPremiumInfo(result, premium),
    okResponse.headers,
  )
}
