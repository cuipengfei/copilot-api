import consola from "consola"
import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { resolveMappedModel } from "~/lib/config"
import {
  colorizeModel,
  createHandlerLogger,
  debugJson,
  shouldUseColor,
} from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { writeSSEIfConnected } from "~/lib/sse"
import { resolveConfiguredProviderModelAlias } from "~/lib/provider-resolver"
import {
  copilotUsageToTokens,
  createCopilotTokenUsageRecorder,
  mergeCopilotUsage,
  normalizeOpenAIUsage,
  type CopilotUsageTokens,
  type UsageTokens,
} from "~/lib/token-usage"
import {
  applyForwardableResponseHeaders,
  getAttachedResponseHeaders,
  jsonWithForwardedHeaders,
} from "~/lib/response-headers"
import { generateRequestIdFromPayload, getUUID, isNullish } from "~/lib/utils"
import { handleProviderChatCompletionsForProvider } from "~/routes/provider/chat-completions/handler"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/lib/types/chat-completions"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

const logger = createHandlerLogger("chat-completions-handler")

export async function handleCompletion(c: Context) {
  let payload = await c.req.json<ChatCompletionsPayload>()
  const requestedModel = payload.model
  payload.model = resolveMappedModel(payload.model)
  if (payload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }

  const providerModelAlias = await resolveConfiguredProviderModelAlias(
    payload.model,
  )
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    return await handleProviderChatCompletionsForProvider(c, {
      payload,
      provider: providerModelAlias.provider,
    })
  }

  debugJson(logger, "Request payload:", payload)

  const selectedModel = findEndpointModel(payload.model)
  payload.model = selectedModel?.id ?? payload.model

  if (
    isNullish(payload.max_tokens)
    && isNullish(payload.max_completion_tokens)
  ) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities?.limits?.max_output_tokens,
    }
    debugJson(logger, "Set max_tokens to:", payload.max_tokens)
  }

  if (payload.model.includes("gpt")) {
    if (isNullish(payload.max_completion_tokens)) {
      payload.max_completion_tokens = payload.max_tokens
    }
    delete payload.max_tokens
  }

  // not support subagent marker for now , set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload(payload)
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "chat_completions",
    fallbackSessionId: sessionId,
    model: payload.model,
  })

  const modelLabel =
    shouldUseColor() ? colorizeModel(payload.model) : payload.model
  const effortSuffix =
    payload.reasoning_effort ?
      ` [effort=${payload.reasoning_effort} (request)]`
    : ""
  consola.info(`IN ${modelLabel}${effortSuffix}`)

  const response = await createChatCompletions(payload, {
    clientSignal: c.req.raw.signal,
    requestId,
    sessionId,
  })
  const sourceHeaders = getAttachedResponseHeaders(response)

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response:", response)
    recordUsage(
      normalizeOpenAIUsage(response.usage),
      response.copilot_usage ?? null,
    )
    return jsonWithForwardedHeaders(response, sourceHeaders)
  }

  logger.debug("Streaming response")
  applyForwardableResponseHeaders(c, sourceHeaders)
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    let copilotUsage: CopilotUsageTokens = {}
    for await (const chunk of response) {
      debugJson(logger, "Streaming chunk:", chunk)
      const parsedChunk = parseChatCompletionChunk(chunk)
      if (parsedChunk?.usage) {
        usage = normalizeOpenAIUsage(parsedChunk.usage)
      }
      if (parsedChunk?.copilot_usage) {
        copilotUsage = mergeCopilotUsage(
          copilotUsage,
          copilotUsageToTokens(parsedChunk.copilot_usage),
        )
      }
      await writeSSEIfConnected(stream, chunk as SSEMessage)
    }
    recordUsage(usage, copilotUsage)
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const parseChatCompletionChunk = (
  chunk: unknown,
): ChatCompletionChunk | null => {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") {
    return null
  }

  try {
    return JSON.parse(data) as ChatCompletionChunk
  } catch {
    return null
  }
}
