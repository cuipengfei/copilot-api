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

type StreamError = { message?: string }

type ParsedChatStreamEvent =
  { chunk: ChatCompletionChunk } | { error: StreamError }

const readErrorMessage = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const text = value.trim()
    if (!text) return undefined
    try {
      return readErrorMessage(JSON.parse(text))
    } catch {
      // 纯文本 / 非法 JSON 正文本身就是错误文本。
      return text
    }
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message
    }
    if (record.error !== undefined) return readErrorMessage(record.error)
  }
  return undefined
}

const readPayloadError = (payload: unknown): StreamError | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined
  const { error } = payload as { error?: unknown }
  if (error === undefined || error === null) return undefined
  return { message: readErrorMessage(error) }
}

const parseChatStreamEvent = (
  value: unknown,
): ParsedChatStreamEvent | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  // createChatCompletions 流式返回 fetch-event-stream envelope
  // （{ event?: "error", data: "<json>" }）；data 缺失时容忍裸事件。
  const record = value as Record<string, unknown>
  const isErrorEvent = record.event === "error"
  const data = "data" in record ? record.data : value

  let payload: unknown = data
  if (typeof data === "string") {
    if (data === "" || data === "[DONE]") {
      return isErrorEvent ? { error: {} } : undefined
    }
    try {
      payload = JSON.parse(data)
    } catch {
      return isErrorEvent ? { error: { message: data } } : undefined
    }
  }

  // 错误优先于 choices 识别；无 choices 的 error 载荷同样失败。
  const error =
    isErrorEvent ?
      { message: readErrorMessage(payload) }
    : readPayloadError(payload)
  if (error) return { error }

  return (
      typeof payload === "object"
        && payload !== null
        && isChatCompletionChunkShape(payload)
    ) ?
      { chunk: payload }
    : undefined
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
    let streamError: Error | undefined
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
        const parsed = parseChatStreamEvent(rawEvent)
        if (!parsed) continue
        if ("error" in parsed) {
          streamError ??= new Error(
            parsed.error.message ?? "Upstream Chat Completions stream error",
          )
          continue
        }
        const { chunk } = parsed
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
        if (streamError) {
          if (chunk.usage) state.latestUsage = chunk.usage
          if (chunk.copilot_usage) {
            state.latestCopilotUsage = mergeCopilotUsage(
              state.latestCopilotUsage ?? {},
              chunk.copilot_usage,
            )
          }
          continue
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
      if (streamError) throw streamError

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
