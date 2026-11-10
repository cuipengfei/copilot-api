import type { Context } from "hono"

import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import type {
  AnthropicMessageDeltaEvent,
  AnthropicMessagesPayload,
  AnthropicStreamState,
} from "~/lib/types/anthropic"
import type {
  ChatCompletionErrorResponse,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/lib/types/chat-completions"

import {
  getChatCompletionFailure,
  guardChatCompletionsStream,
  type ChatCompletionFailure,
} from "~/lib/chat-completions-stream"
import { type ModelConfig, type ResolvedProviderConfig } from "~/lib/config"
import { getProviderModelConfig } from "~/lib/provider-model-catalog"
import {
  applyDashScopePreserveThinkingDefault,
  applyOpenAICompatibleContextCache,
  isDashScopeAliyunProvider,
} from "~/lib/dashscope"
import { HTTPError } from "~/lib/error"
import { recordChatCompletionFirstToken } from "~/lib/first-token"
import { debugJson, debugLazy } from "~/lib/logger"
import { getProviderModelPdfSupport } from "~/lib/model-pdf-support"
import {
  applyForwardableResponseHeaders,
  jsonWithForwardedHeaders,
} from "~/lib/response-headers"
import { writeSSEIfConnected } from "~/lib/sse"
import {
  copilotUsageToTokens,
  mergeAnthropicUsage,
  mergeCopilotUsage,
  normalizeOpenAIUsage,
  type CopilotUsageTokens,
  type TokenUsageEndpoint,
  type UsageTokens,
} from "~/lib/token-usage"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "~/routes/messages/completions-translation"
import {
  flushPendingAnthropicStreamEvents,
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "~/routes/messages/completions-stream-translation"

import { forwardProviderChatCompletions } from "~/services/providers/provider-proxy"
import { applyMissingExtraBody } from "~/routes/provider/utils"
import {
  dropUnsupportedThinkingBudget,
  logReasoningTextOpaqueDrops,
} from "../local-behavior"

import { logger } from "./log"
import { createProviderMessagesUsageRecorder } from "./usage"

export const getRequestThinkingBudget = (
  payload: AnthropicMessagesPayload,
): number | undefined => {
  const budget = payload.thinking?.budget_tokens
  if (typeof budget !== "number" || !Number.isFinite(budget)) {
    return undefined
  }
  return budget
}

export const applyOpenAICompatibleThinkingBudget = (
  payload: ChatCompletionsPayload,
  source: AnthropicMessagesPayload,
): void => {
  const thinkingBudget = getRequestThinkingBudget(source)
  if (thinkingBudget !== undefined) {
    payload.thinking_budget = thinkingBudget
    return
  }

  if (payload.thinking_budget === undefined) {
    delete payload.thinking_budget
  }
}

export const applyOpenAICompatibleExtraBodyThinkingBudget = (
  payload: ChatCompletionsPayload,
  options: { extraBody: Record<string, unknown> | undefined },
): void => {
  const { extraBody } = options
  if (!extraBody || !Object.hasOwn(extraBody, "thinking_budget")) {
    return
  }

  const rawPayload = payload as Record<string, unknown>
  rawPayload.thinking_budget = extraBody.thinking_budget
}

export const handleOpenAICompatibleProviderMessages = async (
  c: Context,
  options: {
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
    usageEndpoint?: TokenUsageEndpoint
  },
): Promise<Response> => {
  const { modelConfig, payload, provider, providerConfig, usageEndpoint } =
    options
  const openAIPayload = createOpenAICompatiblePayload(
    payload,
    modelConfig,
    providerConfig,
  )
  debugJson(logger, "provider.messages.openai_compatible.request", {
    payload: openAIPayload,
    provider,
  })

  const upstreamResponse = await forwardProviderChatCompletions(
    providerConfig,
    openAIPayload,
    c.req.raw.headers,
    { clientSignal: c.req.raw.signal },
  )

  if (!upstreamResponse.ok) {
    logger.error(
      "Failed to create openai-compatible responses",
      upstreamResponse,
    )
    throw new HTTPError(
      "Failed to create openai-compatible responses",
      upstreamResponse,
    )
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? ""
  const isStreamingResponse =
    Boolean(openAIPayload.stream) && contentType.includes("text/event-stream")

  if (isStreamingResponse) {
    return streamOpenAICompatibleProviderMessages({
      c,
      modelConfig,
      payload,
      pricingCurrency: providerConfig.pricingCurrency,
      provider,
      upstreamResponse,
      usageEndpoint,
    })
  }

  const jsonBody = (await upstreamResponse.json()) as
    ChatCompletionResponse | ChatCompletionErrorResponse
  return respondOpenAICompatibleProviderMessagesJson(c, {
    body: jsonBody,
    modelConfig,
    payload,
    pricingCurrency: providerConfig.pricingCurrency,
    provider,
    sourceHeaders: upstreamResponse.headers,
    usageEndpoint,
  })
}

export const createOpenAICompatiblePayload = (
  payload: AnthropicMessagesPayload,
  modelConfig: ModelConfig | undefined,
  providerConfig: ResolvedProviderConfig,
): ChatCompletionsPayload => {
  const openAIPayload = translateToOpenAI(payload, {
    supportPdf: getProviderModelPdfSupport(payload.model, providerConfig),
    toolContentSupportType: modelConfig?.toolContentSupportType ?? [],
  })

  const isDashScopeProvider = isDashScopeAliyunProvider(providerConfig)

  if (isDashScopeProvider) {
    applyOpenAICompatibleThinkingBudget(openAIPayload, payload)
  } else {
    dropUnsupportedThinkingBudget(openAIPayload)
  }

  if (payload.top_k !== undefined) {
    openAIPayload.top_k = payload.top_k
  }

  if (openAIPayload.stream) {
    openAIPayload.stream_options = {
      include_usage: true,
    }
  }

  logReasoningTextOpaqueDrops({
    messages: openAIPayload.messages,
    model: openAIPayload.model,
    modelConfig,
    providerConfig,
  })
  normalizeOpenAICompatibleReasoningContent(openAIPayload, {
    modelConfig,
    providerConfig,
  })

  applyOpenAICompatibleRequestOverrides(openAIPayload, {
    extraBody: modelConfig?.extraBody,
    source: payload as unknown as Record<string, unknown>,
  })

  applyMissingExtraBody(openAIPayload, {
    extraBody: modelConfig?.extraBody,
  })

  applyOpenAICompatibleExtraBodyThinkingBudget(openAIPayload, {
    extraBody: modelConfig?.extraBody,
  })

  applyMiMoThinking(openAIPayload, payload)

  applyDashScopePreserveThinkingDefault(openAIPayload, providerConfig)

  if (!Object.hasOwn(openAIPayload, "parallel_tool_calls")) {
    openAIPayload.parallel_tool_calls = true
  }

  const contextCacheEnabled = modelConfig?.contextCache ?? isDashScopeProvider
  if (contextCacheEnabled) {
    applyOpenAICompatibleContextCache(openAIPayload)
  }

  return openAIPayload
}

export const applyMiMoThinking = (
  payload: ChatCompletionsPayload,
  source: AnthropicMessagesPayload,
): void => {
  if (!/(?:^|\/)mimo(?:[-_.]|$)/i.test(payload.model)) {
    return
  }

  const sourceThinkingType = source.thinking?.type
  const shouldEnableThinking = Boolean(
    payload.reasoning_effort || sourceThinkingType,
  )
  delete payload.reasoning_effort

  if (sourceThinkingType === "disabled") {
    payload.thinking = { type: "disabled" }
    delete payload.thinking_budget
    return
  }

  if (shouldEnableThinking) {
    payload.thinking = { type: "enabled" }
  }
}

export const normalizeOpenAICompatibleReasoningContent = (
  payload: ChatCompletionsPayload,
  options: {
    modelConfig: ModelConfig | undefined
    providerConfig: ResolvedProviderConfig
  },
): void => {
  // Some models (e.g. opencode-go hy3/hy4) follow the OpenRouter convention
  // and expect the reasoning text in the "reasoning" field of assistant
  // history messages instead of the default "reasoning_content" field
  const reasoningField =
    options.modelConfig?.reasoningField
    ?? getProviderModelConfig(
      options.providerConfig.name,
      payload.model,
      options.providerConfig,
    )?.reasoningField
    ?? "reasoning_content"

  for (const message of payload.messages) {
    if (message.role !== "assistant") {
      continue
    }

    const reasoningText =
      message.reasoning_text ?? message.reasoning_content ?? message.reasoning
    if (reasoningText && reasoningText.length > 0) {
      if (reasoningField === "reasoning") {
        message.reasoning ??= reasoningText
      } else {
        message.reasoning_content ??= reasoningText
      }
    }

    // Send exactly one reasoning field upstream, even when the history
    // message carries an empty value in the field this model does not use
    if (reasoningField === "reasoning") {
      delete message.reasoning_content
    } else {
      delete message.reasoning
    }

    delete message.reasoning_text
    delete message.reasoning_opaque
  }
}

export const applyOpenAICompatibleRequestOverrides = (
  payload: ChatCompletionsPayload,
  options: {
    extraBody: Record<string, unknown> | undefined
    source: Record<string, unknown>
  },
): void => {
  const allowedKeys = new Set(Object.keys(options.extraBody ?? {}))
  for (const key of allowedKeys) {
    if (Object.hasOwn(options.source, key)) {
      payload[key] = options.source[key]
    }
  }
}

export const streamOpenAICompatibleProviderMessages = ({
  c,
  modelConfig,
  payload,
  pricingCurrency,
  provider,
  upstreamResponse,
  usageEndpoint,
}: {
  c: Context
  modelConfig: ModelConfig | undefined
  payload: AnthropicMessagesPayload
  pricingCurrency: string | undefined
  provider: string
  upstreamResponse: Response
  usageEndpoint?: TokenUsageEndpoint
}): Response => {
  logger.debug("provider.messages.openai_compatible.streaming")
  applyForwardableResponseHeaders(c, upstreamResponse.headers)
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
    usageEndpoint,
  )
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    let copilotUsage: CopilotUsageTokens | undefined
    let failure: ChatCompletionFailure | undefined
    let terminalEvent: AnthropicMessageDeltaEvent | undefined
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageCompleted: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }

    try {
      try {
        for await (const guarded of guardChatCompletionsStream(
          events(upstreamResponse),
          { reportPostFinishErrors: true },
        )) {
          if (guarded.failure) {
            failure = guarded.failure
            logger.warn(
              "provider.messages.openai_compatible.generation_failed",
              {
                provider,
                type: failure.type,
                code: failure.code,
                message: failure.message,
              },
            )
            continue
          }
          const { message: chunk, completion: parsed } = guarded
          if (chunk.event === "ping") {
            await writeSSEIfConnected(stream, {
              event: "ping",
              data: '{"type":"ping"}',
            })
            continue
          }
          if (!parsed || !chunk.data || chunk.data === "[DONE]") {
            continue
          }
          logger.debug(
            "provider.messages.openai_compatible.raw_stream_event:",
            chunk.data,
          )
          recordChatCompletionFirstToken(parsed)
          if (parsed.usage) {
            usage = mergeAnthropicUsage(
              usage,
              normalizeOpenAIUsage(parsed.usage),
            )
          }
          if (parsed.copilot_usage) {
            copilotUsage = mergeCopilotUsage(
              copilotUsage ?? {},
              copilotUsageToTokens(parsed.copilot_usage),
            )
          }

          const translatedEvents = translateChunkToAnthropicEvents(
            parsed,
            streamState,
          )
          for (const event of translatedEvents) {
            // A finish can still be followed by usage or failure.
            if (event.type === "message_delta") {
              terminalEvent = event
              continue
            }
            if (event.type === "message_stop") {
              continue
            }
            const eventData = JSON.stringify(event)
            debugLazy(logger, () => [
              "provider.messages.openai_compatible.translated_event:",
              eventData,
            ])
            await writeSSEIfConnected(stream, {
              event: event.type,
              data: eventData,
            })
          }
        }
      } catch {
        logger.warn("provider.messages.openai_compatible.stream_interrupted:", {
          provider,
        })
      }

      const finalEvents = flushPendingAnthropicStreamEvents(
        streamState,
        failure,
      )
      if (!failure && finalEvents.length === 0 && terminalEvent) {
        finalEvents.push(terminalEvent, { type: "message_stop" })
      }
      for (const event of finalEvents) {
        const eventData = JSON.stringify(event)
        if (event.type !== "error") {
          debugLazy(logger, () => [
            "provider.messages.openai_compatible.translated_event:",
            eventData,
          ])
        }
        await writeSSEIfConnected(stream, {
          event: event.type,
          data: eventData,
        })
      }

      if (!streamState.messageCompleted && !streamState.failureEmitted) {
        logger.warn("provider.messages.openai_compatible.stream_incomplete:", {
          provider,
        })
        const errorEvent = translateErrorToAnthropicErrorEvent()
        await writeSSEIfConnected(stream, {
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      }
    } finally {
      try {
        recordUsage(usage, copilotUsage)
      } finally {
        if (!stream.closed) {
          await stream.close()
        }
      }
    }
  })
}

export const respondOpenAICompatibleProviderMessagesJson = (
  _c: Context,
  options: {
    body: ChatCompletionResponse | ChatCompletionErrorResponse
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    pricingCurrency: string | undefined
    provider: string
    sourceHeaders?: Headers | null
    usageEndpoint?: TokenUsageEndpoint
  },
): Response => {
  const {
    body,
    modelConfig,
    payload,
    pricingCurrency,
    provider,
    sourceHeaders,
    usageEndpoint,
  } = options
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
    usageEndpoint,
  )
  recordUsage(
    normalizeOpenAIUsage(body.usage),
    copilotUsageToTokens(body.copilot_usage),
  )
  const failure = getChatCompletionFailure(body)
  if (failure) {
    logger.warn("provider.messages.openai_compatible.generation_failed", {
      provider,
      type: failure.type,
      code: failure.code,
      message: failure.message,
    })
    return jsonWithForwardedHeaders(
      translateErrorToAnthropicErrorEvent(failure),
      sourceHeaders,
      { status: 502 },
    )
  }

  const anthropicResponse = translateToAnthropic(body as ChatCompletionResponse)
  debugJson(
    logger,
    "provider.messages.openai_compatible.no_stream result:",
    anthropicResponse,
  )
  return jsonWithForwardedHeaders(anthropicResponse, sourceHeaders)
}
