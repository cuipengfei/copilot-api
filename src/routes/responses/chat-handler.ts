import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"

import {
  getChatCompletionFailure,
  guardChatCompletionsStream,
} from "~/lib/chat-completions-stream"
import { createHandlerLogger, writeStreamLog } from "~/lib/logger"
import {
  applyForwardableResponseHeaders,
  getAttachedResponseHeaders,
  jsonWithForwardedHeaders,
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
import type { ChatCompletionResponse } from "~/lib/types/chat-completions"
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
  translateChatCompletionToResponsesResult,
  translateResponsesToChatCompletions,
} from "./responses-from-chat"
import { compactInputByLatestCompaction } from "./utils"

const logger = createHandlerLogger("responses-chat-handler")

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
  const upstreamHeaders = getAttachedResponseHeaders(chatResponse)
  applyForwardableResponseHeaders(c, upstreamHeaders)

  if (!isAsyncIterable<ServerSentEventMessage>(chatResponse)) {
    const failure = getChatCompletionFailure(chatResponse)
    if (failure) {
      logger.error("Chat completion failed", {
        type: failure.type,
        code: failure.code,
        message: failure.message,
      })
    }
    if (
      !failure
      && (options.payload.stream || !isChatCompletionResponse(chatResponse))
    ) {
      return c.json(
        {
          error: {
            message: "Chat Completions fallback did not return a completion",
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
    const result = translateChatCompletionToResponsesResult(chatResponse)
    result.model ||= options.payload.model
    return jsonWithForwardedHeaders(result, upstreamHeaders, {
      status: failure ? 502 : 200,
    })
  }

  if (!options.payload.stream) {
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
      for await (const {
        completion: chunk,
        failure,
      } of guardChatCompletionsStream(chatResponse, {
        reportPostFinishErrors: true,
      })) {
        if (failure) {
          state.failure ??= failure
          logger.error("Chat completion failed", {
            type: failure.type,
            code: failure.code,
            message: failure.message,
          })
          continue
        }
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
        state.failure ??=
          getChatCompletionFailure(
            { error: error instanceof Error ? error.message : error },
            "error",
          ) ?? undefined
        for (const event of flushChatCompletionToResponsesStreamEvents(state)) {
          rememberTerminalEvent(event.type)
          await writeSSEIfConnected(stream, {
            event: event.type,
            data: JSON.stringify(event),
          })
        }
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
