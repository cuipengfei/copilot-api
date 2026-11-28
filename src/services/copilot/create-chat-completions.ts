import consola from "consola"
import { events } from "fetch-event-stream"
import { randomUUID } from "node:crypto"

import type { CompactType } from "~/lib/http/compact"
import type { SubagentMarker } from "~/lib/http/subagent"
import type {
  ChatCompletionErrorResponse,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/lib/types/chat-completions"

import {
  copilotBaseUrl,
  copilotHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "~/lib/providers/api-config"
import {
  getReasoningEffortForModel,
  getUpstreamTransportConfig,
} from "~/lib/config"
import { logCopilotRateLimits } from "~/lib/providers/copilot-rate-limit"
import { attachPremiumInfo, getPremiumInfoFromHeaders } from "~/lib/logger"
import { resolveSupportedReasoningEffort } from "~/lib/catalog/reasoning-effort"
import { setPluginRequestActualModel } from "~/lib/http/request-context"
import { attachResponseHeaders } from "~/lib/response-headers"
import { resolveInitiatorWithSmartAgent } from "~/lib/smart-agent"
import { state } from "~/lib/state"
import {
  createMockRequestContext,
  extractUpstreamTelemetryHeaders,
} from "~/services/telemetry/mock-values"
import {
  captureStreamResponseModel,
  scheduleFeedbackEvents,
  schedulePostResponseEvents,
  trackRequestSent,
  trackResponseSuccess,
  trackPanelRequest,
  trackGhostTextShown,
} from "~/services/telemetry/telemetry"

import { attachAutoSessionToken } from "~/services/copilot/auto-session-retry"
import { ensureChatCompletionOkResponse } from "~/services/copilot/chat-completions-compat"
import { applyCopilotContextCache } from "~/services/copilot/context-cache"
import { sendCopilotRequest } from "~/services/copilot/request"

export type { CopilotUsage } from "~/lib/token-usage"

const GEMINI_MODEL_FAMILY = /^gemini(?:-|$)/iu

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
  const telemetryContext = createMockRequestContext({
    requestId,
    model: payload.model,
    sessionId: options?.sessionId,
  })
  trackRequestSent({ context: telemetryContext, modelCallId })

  consola.debug(`<-- model: ${payload.model}`)
  const url = `${copilotBaseUrl(state)}/chat/completions`
  setPluginRequestActualModel(payload.model)

  const reasoningEffort = resolveChatCompletionsReasoningEffort(payload)
  const upstreamPayload =
    reasoningEffort === payload.reasoning_effort ?
      payload
    : { ...payload, reasoning_effort: reasoningEffort }
  const modelMetadata = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  if (
    modelMetadata
    && GEMINI_MODEL_FAMILY.test(modelMetadata.capabilities.family)
  ) {
    applyCopilotContextCache(upstreamPayload)
  }
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
    telemetryContext,
    clientSignal: options?.clientSignal,
  })

  const timeSinceIssuedMs = Date.now() - start
  Object.assign(
    telemetryContext,
    extractUpstreamTelemetryHeaders(okResponse.headers),
  )
  const emitCompletionSuccessTelemetry = (options: {
    finishReason: string
    modelInvoked?: string
    promptTokens?: number
    completionTokens?: number
    bytesReceived?: number
  }) => {
    trackPanelRequest(telemetryContext)
    trackGhostTextShown(telemetryContext)
    scheduleFeedbackEvents(telemetryContext)
    schedulePostResponseEvents(telemetryContext)
    trackResponseSuccess({
      model: payload.model,
      modelInvoked: options.modelInvoked,
      apiType: "chatCompletions",
      timeToFirstToken: timeSinceIssuedMs,
      durationMs: Date.now() - start,
      requestId: telemetryContext.requestId,
      modelCallId,
      finishReason: options.finishReason,
      sampled: telemetryContext.sampled,
      conversationId: telemetryContext.conversationId,
      gitHubRequestId: telemetryContext.gitHubRequestId,
      copilotServiceRequestId: telemetryContext.copilotServiceRequestId,
      gitHubCopilotRequestTe: telemetryContext.gitHubCopilotRequestTe,
      promptTokens: options.promptTokens,
      completionTokens: options.completionTokens,
      bytesReceived: options.bytesReceived,
    })
  }

  const premium = getPremiumInfoFromHeaders(okResponse.headers)
  if (payload.stream) {
    const stream = (async function* () {
      try {
        for await (const chunk of events(okResponse)) {
          captureStreamResponseModel({
            context: telemetryContext,
            chunk,
            apiType: "chatCompletions",
          })
          yield chunk
        }
      } finally {
        emitCompletionSuccessTelemetry({
          finishReason: "stream",
          modelInvoked: telemetryContext.modelInvoked,
        })
      }
    })()
    return attachResponseHeaders(
      attachPremiumInfo(stream, premium),
      okResponse.headers,
    )
  }

  const result = (await okResponse.json()) as
    ChatCompletionResponse | ChatCompletionErrorResponse
  const finishReason =
    result.choices?.length ? result.choices[0].finish_reason : "stop"
  emitCompletionSuccessTelemetry({
    finishReason,
    modelInvoked: result.model,
    promptTokens: result.usage?.prompt_tokens,
    completionTokens: result.usage?.completion_tokens,
    bytesReceived: JSON.stringify(result).length,
  })
  return attachResponseHeaders(
    attachPremiumInfo(result, premium),
    okResponse.headers,
  )
}
