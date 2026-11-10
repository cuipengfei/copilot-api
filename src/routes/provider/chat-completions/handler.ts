import { events } from "fetch-event-stream"
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import {
  getChatCompletionFailure,
  guardChatCompletionsStream,
} from "~/lib/chat-completions-stream"
import {
  type ModelConfig,
  type ResolvedProviderConfig,
  resolveProviderConfigForModel,
} from "~/lib/config"
import {
  applyDashScopePreserveThinkingDefault,
  applyOpenAICompatibleContextCache,
  isDashScopeAliyunProvider,
} from "~/lib/dashscope"
import { HTTPError } from "~/lib/error"
import { recordChatCompletionFirstToken } from "~/lib/first-token"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import {
  applyForwardableResponseHeaders,
  jsonWithForwardedHeaders,
} from "~/lib/response-headers"
import { writeSSEIfConnected } from "~/lib/sse"
import {
  copilotUsageToTokens,
  createProviderTokenUsageRecorder,
  normalizeOpenAIUsage,
  mergeCopilotUsage,
  type CopilotUsageTokens,
  type UsageTokens,
} from "~/lib/token-usage"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/lib/types/chat-completions"
import {
  createProviderProxyResponse,
  forwardProviderChatCompletions,
} from "~/services/providers/provider-proxy"
import {
  applyMissingExtraBody,
  applyModelDefaults,
} from "~/routes/provider/utils"

const logger = createHandlerLogger("provider-chat-completions-handler")

export async function handleProviderChatCompletionsForProvider(
  c: Context,
  options: {
    payload: ChatCompletionsPayload
    provider: string
  },
): Promise<Response> {
  const { payload, provider } = options
  const configuredProvider = await resolveProviderConfig(provider)
  const providerConfig =
    configuredProvider
    && resolveProviderConfigForModel(configuredProvider, payload.model)
  if (!providerConfig || providerConfig.type !== "openai-compatible") {
    return c.json(
      {
        error: {
          message: `Provider '${provider}' does not support the /v1/chat/completions endpoint`,
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  const modelConfig = providerConfig.models?.[payload.model]
  applyModelDefaults(payload, modelConfig)
  applyMissingExtraBody(payload, {
    extraBody: modelConfig?.extraBody,
  })
  applyProviderStreamOptions(payload)
  applyDashScopePreserveThinkingDefault(payload, providerConfig)
  applyProviderContextCache(payload, modelConfig, providerConfig)

  const upstreamResponse = await forwardProviderChatCompletions(
    providerConfig,
    payload,
    c.req.raw.headers,
    { clientSignal: c.req.raw.signal },
  )

  if (!upstreamResponse.ok) {
    logger.error("Failed to create provider chat completions", {
      provider,
      statusCode: upstreamResponse.status,
    })
    throw new HTTPError(
      `Failed to create ${provider} chat completions`,
      upstreamResponse,
    )
  }

  const recordUsage = createProviderChatCompletionsUsageRecorder(
    payload,
    provider,
    modelConfig,
    providerConfig.pricingCurrency,
  )
  const contentType = upstreamResponse.headers.get("content-type") ?? ""
  const isStreamingResponse =
    Boolean(payload.stream) && contentType.includes("text/event-stream")

  if (isStreamingResponse) {
    return streamProviderChatCompletions(c, upstreamResponse, {
      provider,
      recordUsage,
    })
  }

  const responseBody = (await upstreamResponse
    .clone()
    .json()) as ChatCompletionResponse
  if (responseBody.copilot_usage) {
    recordUsage(
      normalizeOpenAIUsage(responseBody.usage),
      responseBody.copilot_usage,
    )
  } else {
    recordUsage(normalizeOpenAIUsage(responseBody.usage))
  }
  const failure = getChatCompletionFailure(responseBody)
  if (failure) {
    logger.error("Provider chat completion failed", {
      provider,
      type: failure.type,
      code: failure.code,
      message: failure.message,
    })
    return jsonWithForwardedHeaders(
      { error: failure },
      upstreamResponse.headers,
      {
        status: 502,
      },
    )
  }

  debugJson(logger, "provider.chat_completions.response", responseBody)
  return createProviderProxyResponse(upstreamResponse)
}

const applyProviderStreamOptions = (payload: ChatCompletionsPayload): void => {
  if (!payload.stream) {
    return
  }

  payload.stream_options = {
    ...(payload.stream_options ?? {}),
    include_usage: true,
  }
}

const applyProviderContextCache = (
  payload: ChatCompletionsPayload,
  modelConfig: ModelConfig | undefined,
  providerConfig: ResolvedProviderConfig,
): void => {
  const isDashScopeProvider = isDashScopeAliyunProvider(providerConfig)
  const contextCacheEnabled = modelConfig?.contextCache ?? isDashScopeProvider
  if (contextCacheEnabled) {
    applyOpenAICompatibleContextCache(payload)
  }
}

const createProviderChatCompletionsUsageRecorder = (
  payload: ChatCompletionsPayload,
  provider: string,
  modelConfig: ModelConfig | undefined,
  pricingCurrency: string | undefined,
) =>
  createProviderTokenUsageRecorder({
    endpoint: "chat_completions",
    model: payload.model,
    pricing: modelConfig?.pricing,
    pricingCurrency,
    providerName: provider,
  })

const streamProviderChatCompletions = (
  c: Context,
  upstreamResponse: Response,
  options: {
    provider: string
    recordUsage: (
      usage: UsageTokens,
      copilotUsage?: CopilotUsageTokens | null,
    ) => void
  },
): Response => {
  logger.debug("provider.chat_completions.streaming", {
    provider: options.provider,
  })
  applyForwardableResponseHeaders(c, upstreamResponse.headers)
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    let copilotUsage: CopilotUsageTokens | undefined

    try {
      for await (const {
        message: chunk,
        completion: parsedChunk,
        failure,
      } of guardChatCompletionsStream(events(upstreamResponse))) {
        if (failure) {
          logger.error("Provider chat completion failed", {
            provider: options.provider,
            type: failure.type,
            code: failure.code,
            message: failure.message,
          })
        } else {
          debugJson(logger, "provider.chat_completions.stream_chunk", chunk)
        }
        recordChatCompletionFirstToken(parsedChunk)
        if (parsedChunk?.usage) {
          usage = normalizeOpenAIUsage(parsedChunk.usage)
        }
        if (parsedChunk?.copilot_usage) {
          copilotUsage = mergeCopilotUsage(
            copilotUsage ?? {},
            copilotUsageToTokens(parsedChunk.copilot_usage),
          )
        }

        await writeSSEIfConnected(stream, {
          event: chunk.event,
          data: chunk.data ?? "",
        })
      }
    } finally {
      if (copilotUsage) {
        options.recordUsage(usage, copilotUsage)
      } else {
        options.recordUsage(usage)
      }
    }
  })
}
