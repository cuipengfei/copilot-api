import consola from "consola"
import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { resolveMappedModel } from "~/lib/config"
import { recordChatCompletionFirstToken } from "~/lib/first-token"
import {
  colorizeModel,
  createHandlerLogger,
  debugJson,
  getAttachedPremiumInfo,
  shouldUseColor,
  writeStreamLog,
} from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { writeSSEIfConnected } from "~/lib/sse"
import { setPluginRequestModel } from "~/lib/request-events"
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
import {
  createChatCompletions,
  resolveChatCompletionsReasoningEffort,
} from "~/services/copilot/create-chat-completions"

const logger = createHandlerLogger("chat-completions-handler")

export async function handleCompletion(c: Context) {
  let payload = await c.req.json<ChatCompletionsPayload>()
  setPluginRequestModel(payload.model)
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
  const effort = resolveChatCompletionsReasoningEffort(payload)
  const effortSource =
    payload.reasoning_effort !== undefined ? "request" : "config"
  consola.info(
    `IN ${modelLabel} [effort=${effort ?? "unsupported"} (${effortSource})]`,
  )

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
    const premium = getAttachedPremiumInfo(response)
    writeStreamLog(
      { model: payload.model, chunks: 0, done: true, premium },
      true,
    )
    return jsonWithForwardedHeaders(response, sourceHeaders)
  }

  logger.debug("Streaming response")
  applyForwardableResponseHeaders(c, sourceHeaders)
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    let copilotUsage: CopilotUsageTokens = {}
    let chunkCount = 0
    let completed = false
    let sawTerminal = false
    let streamErrored = false
    try {
      for await (const chunk of response) {
        debugJson(logger, "Streaming chunk:", chunk)
        const parsedChunk = parseChatCompletionChunk(chunk)
        const envelope = chunk as SSEMessage
        if (
          envelope.data === "[DONE]"
          || (parsedChunk?.choices ?? []).some(
            (choice) => typeof choice.finish_reason === "string",
          )
        ) {
          sawTerminal = true
        }
        if (
          envelope.event === "error"
          || (parsedChunk !== null && "error" in parsedChunk)
        ) {
          streamErrored = true
        }
        if (parsedChunk) {
          chunkCount++
          writeStreamLog({
            model: payload.model,
            chunks: chunkCount,
            done: false,
          })
        }
        recordChatCompletionFirstToken(parsedChunk)
        if (parsedChunk?.usage) {
          usage = normalizeOpenAIUsage(parsedChunk.usage)
        }
        if (parsedChunk?.copilot_usage) {
          copilotUsage = mergeCopilotUsage(
            copilotUsage,
            copilotUsageToTokens(parsedChunk.copilot_usage),
          )
        }
        await writeSSEIfConnected(stream, envelope)
      }
      completed = sawTerminal && !streamErrored
    } finally {
      try {
        recordUsage(usage, copilotUsage)
        if (completed && !stream.aborted) {
          const premium = getAttachedPremiumInfo(response)
          writeStreamLog(
            { model: payload.model, chunks: chunkCount, done: true, premium },
            true,
          )
        } else if (chunkCount > 0) {
          // 失败或缺少终态时结束进度行，不输出成功标记。
          writeStreamLog(
            { model: payload.model, chunks: chunkCount, done: false },
            true,
          )
        }
      } finally {
        if (!stream.closed) {
          await stream.close()
        }
      }
    }
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
