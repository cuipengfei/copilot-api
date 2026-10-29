import type { Context } from "hono"
import { streamSSE } from "hono/streaming"

import { writeStreamLog } from "~/lib/logger"
import {
  applyForwardableResponseHeaders,
  getAttachedResponseHeaders,
} from "~/lib/response-headers"
import { writeSSEIfConnected } from "~/lib/sse"
import type { SubagentMarker } from "~/lib/subagent"
import {
  copilotUsageToTokens,
  createCopilotTokenUsageRecorder,
  mergeCopilotUsage,
  normalizeOpenAIUsage,
  type CopilotUsageTokens,
  type UsageTokens,
} from "~/lib/token-usage"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/lib/types/chat-completions"
import type {
  ResponseStreamEvent,
  ResponsesPayload,
} from "~/lib/types/responses"
import { isAsyncIterable } from "~/lib/utils"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

import { logResponsesCompletion } from "./local-behavior"
import {
  createChatCompletionToResponsesStreamState,
  flushChatCompletionToResponsesStreamEvents,
  translateChatCompletionChunkToResponsesStreamEvents,
  translateChatCompletionStreamErrorToResponsesEvent,
  translateChatCompletionToResponsesResult,
  translateResponsesToChatCompletions,
} from "./responses-from-chat"
import { compactInputByLatestCompaction } from "./utils"

export const responsesChatDependencies = {
  createChatCompletions,
}

const isChatCompletionResponse = (
  value: unknown,
): value is ChatCompletionResponse => {
  return (
    typeof value === "object"
    && value !== null
    && "object" in value
    && value.object === "chat.completion"
  )
}

const isChatCompletionChunkShape = (
  value: object,
): value is ChatCompletionChunk => {
  // 真实上游 chunk 必有 choices 数组（usage-only chunk 可能 choices: []）。
  // 不依赖 object 字段：Copilot 上游实际 chunk 无 "chat.completion.chunk"。
  return "choices" in value && Array.isArray(value.choices)
}

const toChatCompletionChunk = (
  value: unknown,
): ChatCompletionChunk | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  // createChatCompletions 流式返回 fetch-event-stream envelope
  // （{ data: "<json>" }）；解包成 ChatCompletionChunk。
  if ("data" in value && typeof value.data === "string") {
    const data = value.data
    if (!data || data === "[DONE]") return undefined
    try {
      const parsed: unknown = JSON.parse(data)
      if (
        typeof parsed === "object"
        && parsed !== null
        && isChatCompletionChunkShape(parsed)
      ) {
        return parsed
      }
      return undefined
    } catch {
      return undefined
    }
  }
  // 兼容测试 / 已解包路径直接给裸 chunk。
  if (isChatCompletionChunkShape(value)) return value
  return undefined
}

export async function handleResponsesViaChatCompletions(
  c: Context,
  options: {
    payload: ResponsesPayload
    clientSignal?: AbortSignal
    subagentMarker?: SubagentMarker | null
    requestId?: string
    sessionId?: string
  },
): Promise<Response> {
  compactInputByLatestCompaction(options.payload)
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "responses",
    fallbackSessionId: options.sessionId,
    model: options.payload.model,
  })
  const chatPayload = translateResponsesToChatCompletions(options.payload)
  const chatResponse = await responsesChatDependencies.createChatCompletions(
    chatPayload,
    {
      clientSignal: options.clientSignal,
      requestId: options.requestId,
      sessionId: options.sessionId,
      subagentMarker: options.subagentMarker,
    },
  )
  applyForwardableResponseHeaders(c, getAttachedResponseHeaders(chatResponse))

  if (!options.payload.stream) {
    if (!isChatCompletionResponse(chatResponse)) {
      return c.json(
        {
          error: {
            message: "Chat Completions fallback returned a stream",
            type: "invalid_request_error",
          },
        },
        502,
      )
    }
    recordUsage(
      normalizeOpenAIUsage(chatResponse.usage),
      copilotUsageToTokens(chatResponse.copilot_usage),
    )
    return c.json(translateChatCompletionToResponsesResult(chatResponse))
  }

  if (!isAsyncIterable<ChatCompletionChunk>(chatResponse)) {
    return c.json(
      {
        error: {
          message: "Chat Completions fallback did not return a stream",
          type: "invalid_request_error",
        },
      },
      502,
    )
  }

  return streamSSE(c, async (stream) => {
    const state = createChatCompletionToResponsesStreamState()
    let chunkCount = 0
    let terminalEventType: ResponseStreamEvent["type"] | undefined
    let streamErrored = false
    let usage: UsageTokens = {}
    let copilotUsage: CopilotUsageTokens = {}
    const rememberTerminalEvent = (eventType: ResponseStreamEvent["type"]) => {
      if (
        eventType === "response.completed"
        || eventType === "response.incomplete"
        || eventType === "response.failed"
      ) {
        terminalEventType = eventType
      }
    }

    try {
      for await (const rawEvent of chatResponse) {
        const chunk = toChatCompletionChunk(rawEvent)
        if (!chunk) continue
        chunkCount++
        writeStreamLog({
          model: options.payload.model,
          chunks: chunkCount,
          done: false,
        })
        if (chunk.usage) {
          usage = normalizeOpenAIUsage(chunk.usage)
        }
        if (chunk.copilot_usage) {
          copilotUsage = mergeCopilotUsage(
            copilotUsage,
            copilotUsageToTokens(chunk.copilot_usage),
          )
        }
        for (const event of translateChatCompletionChunkToResponsesStreamEvents(
          chunk,
          state,
        )) {
          rememberTerminalEvent(event.type)
          await writeSSEIfConnected(stream, {
            event: event.type,
            data: JSON.stringify(event),
          })
        }
      }

      for (const event of flushChatCompletionToResponsesStreamEvents(state)) {
        rememberTerminalEvent(event.type)
        await writeSSEIfConnected(stream, {
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    } catch (error) {
      streamErrored = true
      if (!state.terminalEmitted) {
        const event = translateChatCompletionStreamErrorToResponsesEvent(
          error,
          state,
        )
        await writeSSEIfConnected(stream, {
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    } finally {
      try {
        recordUsage(usage, copilotUsage)
        if (
          !streamErrored
          && terminalEventType === "response.completed"
          && !stream.aborted
          && !options.clientSignal?.aborted
        ) {
          logResponsesCompletion({
            model: options.payload.model,
            response: chatResponse,
            chunks: chunkCount,
          })
        } else if (chunkCount > 0) {
          writeStreamLog(
            { model: options.payload.model, chunks: chunkCount, done: false },
            true,
          )
        }
      } finally {
        if (!stream.closed) await stream.close()
      }
    }
  })
}
