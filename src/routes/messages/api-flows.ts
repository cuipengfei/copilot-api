import type { ConsolaInstance } from "consola"
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type { Model } from "~/lib/types/models"

import {
  getChatCompletionFailure,
  guardChatCompletionsStream,
  type ChatCompletionFailure,
} from "~/lib/chat-completions-stream"
import { getRawProviderConfig } from "~/lib/config"
import {
  recordAnthropicFirstToken,
  recordChatCompletionFirstToken,
  recordResponsesFirstToken,
} from "~/lib/first-token"
import { GITHUB_COPILOT_PROVIDER } from "~/lib/github-copilot-provider"
import {
  debugJson,
  debugJsonTail,
  debugLazy,
  getAttachedPremiumInfo,
  writeStreamLog,
} from "~/lib/logger"
import { getProviderModelPdfSupport } from "~/lib/model-pdf-support"
import { getReasoningReplayIdentity } from "~/lib/reasoning-replay"
import { writeSSEIfConnected } from "~/lib/sse"
import { resolveBridgeToolSearchName } from "~/lib/tool-search"
import {
  applyForwardableResponseHeaders,
  getAttachedResponseHeaders,
  jsonWithForwardedHeaders,
} from "~/lib/response-headers"
import {
  createCopilotTokenUsageRecorder,
  mergeAnthropicUsage,
  mergeCopilotUsage,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  normalizeOptionalToken,
  normalizeResponsesUsage,
  type CopilotUsageTokens,
  type TokenUsageEndpoint,
  type UsageTokens,
} from "~/lib/token-usage"
import { isAsyncIterable, parseUserIdMetadata } from "~/lib/utils"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesTransportForModel,
  getResponsesRequestOptions,
} from "~/routes/responses/utils"
import type { ChatCompletionResponse } from "~/lib/types/chat-completions"
import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import { applyCopilotContextCache } from "~/services/copilot/context-cache"
import { createChatCompletions as createCopilotChatCompletions } from "~/services/copilot/create-chat-completions"
import { createMessages as createCopilotMessages } from "~/services/copilot/create-messages"
import { createResponses as createCopilotResponses } from "~/services/copilot/create-responses"

import {
  type AnthropicMessagesPayload,
  type AnthropicMessageDeltaEvent,
  type AnthropicStreamEventData,
  type AnthropicStreamState,
  type CopilotUsage,
} from "~/lib/types/anthropic"
import { resolveResponsesStreamCopilotUsage } from "./local-behavior"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./completions-translation"
import { prepareMessagesApiPayload } from "./preprocess"
import {
  flushPendingAnthropicStreamEvents,
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./completions-stream-translation"

// 只有上游流正常结束才打印 ✓；失败或取消只结束数字行。
const finishMessagesStreamLog = ({
  response,
  model,
  chunks,
  completed,
}: {
  response: unknown
  model: string
  chunks: number
  completed: boolean
}): void => {
  if (!completed) {
    if (chunks > 0) {
      writeStreamLog({ model, chunks, done: false }, true)
    }
    return
  }
  const premium = getAttachedPremiumInfo(response)
  writeStreamLog({ model, chunks, done: true, premium }, true)
}

export const messagesApiFlowDependencies = {
  createChatCompletions: createCopilotChatCompletions,
  createMessages: createCopilotMessages,
  createResponses: createCopilotResponses,
}

export interface FlowBaseOptions {
  logger: ConsolaInstance
  subagentMarker?: SubagentMarker | null
  requestId: string
  sessionId?: string
  compactType?: CompactType
  usageEndpoint?: TokenUsageEndpoint
}

interface ResponsesFlowOptions extends FlowBaseOptions {
  selectedModel?: Model
}

interface MessagesFlowOptions extends FlowBaseOptions {
  anthropicBetaHeader?: string
  selectedModel?: Model
}

interface ChatCompletionsFlowOptions extends FlowBaseOptions {
  selectedModel?: Model
}

export const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: ChatCompletionsFlowOptions,
) => {
  const {
    logger,
    selectedModel,
    subagentMarker,
    requestId,
    sessionId,
    compactType,
  } = options
  const openAIPayload = translateToOpenAI(anthropicPayload, {
    supportPdf: getProviderModelPdfSupport(
      anthropicPayload.model,
      {
        ...getRawProviderConfig(GITHUB_COPILOT_PROVIDER),
        name: GITHUB_COPILOT_PROVIDER,
      },
      selectedModel,
    ),
    validateReasoningEffort:
      selectedModel?.capabilities?.supports?.reasoning_effort !== undefined,
    reasoningEffortSupport:
      selectedModel?.capabilities?.supports?.reasoning_effort,
  })
  applyCopilotContextCache(openAIPayload)
  const recordUsage = createCopilotUsageRecorder({
    endpoint: options.usageEndpoint ?? "chat_completions",
    fallbackSessionId: sessionId,
    model: openAIPayload.model,
    payload: anthropicPayload,
  })
  debugJson(logger, "Translated OpenAI request payload:", openAIPayload)

  const response = await messagesApiFlowDependencies.createChatCompletions(
    openAIPayload,
    {
      clientSignal: c.req?.raw?.signal,
      subagentMarker,
      requestId,
      sessionId,
      compactType,
    },
  )
  const sourceHeaders = getAttachedResponseHeaders(response)

  if (!isAsyncIterable(response)) {
    recordUsage(normalizeOpenAIUsage(response.usage), response.copilot_usage)
    const failure = getChatCompletionFailure(response)
    if (failure) {
      logger.warn("Chat completions generation failed", {
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
    debugJson(logger, "Non-streaming response from Copilot:", response)
    const anthropicResponse = translateToAnthropic(
      response as ChatCompletionResponse,
    )
    debugJson(logger, "Translated Anthropic response:", anthropicResponse)
    return jsonWithForwardedHeaders(anthropicResponse, sourceHeaders)
  }

  logger.debug("Streaming response from Copilot")
  applyForwardableResponseHeaders(c, sourceHeaders)
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    let copilotUsage: CopilotUsageTokens = {}
    let failure: ChatCompletionFailure | undefined
    let terminalEvent: AnthropicMessageDeltaEvent | undefined
    let chunks = 0
    let streamInterrupted = false
    let loopCompleted = false
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
        for await (const guarded of guardChatCompletionsStream(response, {
          reportPostFinishErrors: true,
        })) {
          if (guarded.failure) {
            failure = guarded.failure
            streamInterrupted = true
            logger.warn("Chat completions generation failed", {
              type: failure.type,
              code: failure.code,
              message: failure.message,
            })
            continue
          }
          const { message: rawEvent, completion: chunk } = guarded
          if (!chunk || !rawEvent.data || rawEvent.data === "[DONE]") {
            continue
          }
          debugJson(logger, "Copilot raw stream event:", rawEvent)
          chunks += 1
          writeStreamLog({ model: openAIPayload.model, chunks, done: false })
          recordChatCompletionFirstToken(chunk)
          if (chunk.usage) {
            usage = mergeAnthropicUsage(
              usage,
              normalizeOpenAIUsage(chunk.usage),
            )
          }
          if (chunk.copilot_usage) {
            copilotUsage = mergeCopilotUsage(copilotUsage, chunk.copilot_usage)
          }
          const events = translateChunkToAnthropicEvents(chunk, streamState)

          for (const event of events) {
            // A tool-call finish can be followed by more output or a failure.
            if (event.type === "message_delta") {
              terminalEvent = event
              continue
            }
            if (event.type === "message_stop") {
              continue
            }
            const eventData = JSON.stringify(event)
            debugLazy(logger, () => ["Translated Anthropic event:", eventData])
            await writeSSEIfConnected(stream, {
              event: event.type,
              data: eventData,
            })
          }
        }
      } catch {
        streamInterrupted = true
        logger.warn("Chat completions stream interrupted")
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
          debugLazy(logger, () => ["Translated Anthropic event:", eventData])
        }
        await writeSSEIfConnected(stream, {
          event: event.type,
          data: eventData,
        })
      }

      if (!streamState.messageCompleted && !streamState.failureEmitted) {
        logger.warn(
          "Chat completions stream ended without completion; sending error event",
        )
        const errorEvent = translateErrorToAnthropicErrorEvent()
        await writeSSEIfConnected(stream, {
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      }
      loopCompleted = true
    } finally {
      try {
        recordUsage(usage, copilotUsage)
        finishMessagesStreamLog({
          response,
          model: openAIPayload.model,
          chunks,
          completed:
            loopCompleted
            && streamState.messageCompleted
            && !streamInterrupted
            && !stream.aborted
            && !c.req.raw.signal.aborted,
        })
      } finally {
        if (!stream.closed) {
          await stream.close()
        }
      }
    }
  })
}

export const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: ResponsesFlowOptions,
) => {
  const { logger, selectedModel, ...requestOptions } = options

  const responsesPayload =
    translateAnthropicMessagesToResponsesPayload(anthropicPayload)
  const recordUsage = createCopilotUsageRecorder({
    endpoint: options.usageEndpoint ?? "responses",
    fallbackSessionId: requestOptions.sessionId,
    model: responsesPayload.model,
    payload: anthropicPayload,
  })

  const shouldCompactInput = applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
    {
      source: "messages",
    },
  )

  if (shouldCompactInput) {
    compactInputByLatestCompaction(responsesPayload)
  }

  debugJson(logger, "Translated Responses payload:", responsesPayload)

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const transport =
    getResponsesTransportForModel(selectedModel, {
      compactType: requestOptions.compactType,
    }) ?? "http"
  const response = await messagesApiFlowDependencies.createResponses(
    responsesPayload,
    {
      vision,
      initiator,
      clientSignal: c.req?.raw?.signal,
      transport,
      reasoningReplayIdentity: getReasoningReplayIdentity(
        c.req.raw.headers,
        responsesPayload.prompt_cache_key,
      ),
      ...requestOptions,
    },
  )
  const sourceHeaders = getAttachedResponseHeaders(response)

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")
    applyForwardableResponseHeaders(c, sourceHeaders)
    return streamSSE(c, async (stream) => {
      const streamState = createResponsesStreamState({
        toolSearchName: resolveBridgeToolSearchName(anthropicPayload.tools),
      })
      let usage: UsageTokens = {}
      let copilotUsage: CopilotUsageTokens | null = null
      let responseUsage: NonNullable<
        Parameters<typeof normalizeResponsesUsage>[0]
      > = {}
      let chunks = 0
      let terminalEventType: ResponseStreamEvent["type"] | undefined
      let loopCompleted = false

      try {
        try {
          for await (const chunk of response) {
            chunks += 1
            writeStreamLog({
              model: responsesPayload.model,
              chunks,
              done: false,
            })
            const eventName = chunk.event
            if (eventName === "ping") {
              await writeSSEIfConnected(stream, {
                event: "ping",
                data: '{"type":"ping"}',
              })
              continue
            }

            const data = chunk.data
            if (!data || data === "[DONE]") {
              continue
            }

            debugLazy(logger, () => ["Responses raw stream event:", data])

            let responseEvent: ResponseStreamEvent
            try {
              responseEvent = JSON.parse(data) as ResponseStreamEvent
            } catch (error) {
              logger.warn(
                "Responses stream event is not valid JSON; stopping translation",
                error,
              )
              break
            }
            recordResponsesFirstToken(responseEvent)
            if ("response" in responseEvent) {
              const nextUsage = responseEvent.response.usage
              if (nextUsage) {
                responseUsage = {
                  ...responseUsage,
                  ...nextUsage,
                  input_tokens_details: {
                    ...responseUsage.input_tokens_details,
                    ...nextUsage.input_tokens_details,
                  },
                }
              }
              const resolvedCopilotUsage =
                resolveResponsesStreamCopilotUsage(responseEvent)
              usage = mergeAnthropicUsage(usage, {
                ...(nextUsage ? normalizeResponsesUsage(responseUsage) : {}),
                cache_creation_input_tokens: normalizeOptionalToken(
                  responseUsage.input_tokens_details?.cache_write_tokens,
                ),
                total_nano_aiu: resolvedCopilotUsage.totalNanoAiu,
              })
              if (resolvedCopilotUsage.copilotUsage) {
                copilotUsage = mergeCopilotUsage(copilotUsage ?? {}, {
                  ...resolvedCopilotUsage.copilotUsage,
                  total_nano_aiu: resolvedCopilotUsage.totalNanoAiu,
                })
              }
            }
            if (
              responseEvent.type === "response.completed"
              || responseEvent.type === "response.failed"
              || responseEvent.type === "response.incomplete"
            ) {
              terminalEventType = responseEvent.type
            }

            const events = translateResponsesStreamEvent(
              responseEvent,
              streamState,
            )
            for (const event of events) {
              const eventData = JSON.stringify(event)
              debugLazy(logger, () => [
                "Translated Anthropic event:",
                eventData,
              ])
              await writeSSEIfConnected(stream, {
                event: event.type,
                data: eventData,
              })
            }

            if (streamState.messageCompleted) {
              logger.debug("Message completed, ending stream")
              break
            }
          }

          loopCompleted = true
        } catch (error) {
          logger.warn("Responses stream interrupted:", error)
        }

        if (!streamState.messageCompleted) {
          logger.warn(
            "Responses stream ended without completion; sending error event",
          )
          const errorEvent = buildErrorEvent(
            "Responses stream ended without completion, retry your request.",
          )
          await writeSSEIfConnected(stream, {
            event: errorEvent.type,
            data: JSON.stringify(errorEvent),
          })
        }
      } finally {
        try {
          recordUsage(usage, copilotUsage)
          finishMessagesStreamLog({
            response,
            model: responsesPayload.model,
            chunks,
            completed:
              loopCompleted
              && terminalEventType === "response.completed"
              && !stream.aborted
              && !c.req.raw.signal.aborted,
          })
        } finally {
          if (!stream.closed) {
            await stream.close()
          }
        }
      }
    })
  }

  debugJson(logger, "Non-streaming Responses result:", response)
  const anthropicResponse = translateResponsesResultToAnthropic(
    response as ResponsesResult,
    {
      toolSearchName: resolveBridgeToolSearchName(anthropicPayload.tools),
    },
  )
  const responsesResult = response as ResponsesResult
  recordUsage({
    ...normalizeResponsesUsage(responsesResult.usage),
    total_nano_aiu: normalizeOptionalToken(
      responsesResult.copilot_usage?.total_nano_aiu,
    ),
  })
  debugJson(logger, "Translated Anthropic response:", anthropicResponse)
  return jsonWithForwardedHeaders(anthropicResponse, sourceHeaders)
}

export const handleWithMessagesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: MessagesFlowOptions,
) => {
  const {
    logger,
    anthropicBetaHeader,
    subagentMarker,
    selectedModel,
    requestId,
    sessionId,
    compactType,
  } = options

  prepareMessagesApiPayload(anthropicPayload, selectedModel)
  const recordUsage = createCopilotUsageRecorder({
    endpoint: options.usageEndpoint ?? "messages",
    fallbackSessionId: sessionId,
    model: anthropicPayload.model,
    payload: anthropicPayload,
  })

  debugJson(logger, "Translated Messages payload:", anthropicPayload)

  const response = await messagesApiFlowDependencies.createMessages(
    anthropicPayload,
    anthropicBetaHeader,
    {
      anthropicVersionHeader: c.req?.header("anthropic-version"),
      clientSignal: c.req?.raw?.signal,
      subagentMarker,
      requestId,
      sessionId,
      compactType,
    },
  )
  const sourceHeaders = getAttachedResponseHeaders(response)

  if (isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Messages API)")
    applyForwardableResponseHeaders(c, sourceHeaders)
    return streamSSE(c, async (stream) => {
      let usage: UsageTokens = {}
      let chunks = 0
      let messageStopSeen = false
      let errorSeen = false
      let streamInterrupted = false

      try {
        try {
          for await (const event of response) {
            const eventName = event.event
            const data = event.data ?? ""
            if (data === "[DONE]") {
              break
            }
            if (!data) {
              continue
            }
            chunks += 1
            writeStreamLog({
              model: anthropicPayload.model,
              chunks,
              done: false,
            })
            debugLazy(logger, () => ["Messages raw stream event:", data])
            const parsedEvent = parseAnthropicStreamEvent(data)
            recordAnthropicFirstToken(parsedEvent)
            if (parsedEvent?.type === "message_start") {
              usage = mergeAnthropicUsage(usage, {
                ...normalizeAnthropicUsage(parsedEvent.message.usage),
                ...normalizeCopilotUsage(parsedEvent.message.copilot_usage),
              })
            } else if (parsedEvent?.type === "message_delta") {
              usage = mergeAnthropicUsage(usage, {
                ...normalizeAnthropicUsage(parsedEvent.usage),
                ...normalizeCopilotUsage(parsedEvent.copilot_usage),
              })
            }
            if (
              parsedEvent?.type === "message_stop"
              || eventName === "message_stop"
            ) {
              messageStopSeen = true
            }
            if (parsedEvent?.type === "error" || eventName === "error") {
              errorSeen = true
            }
            await writeSSEIfConnected(
              stream,
              { event: eventName, data },
              parsedEvent?.type,
            )
          }
        } catch (error) {
          streamInterrupted = true
          logger.warn("Messages stream interrupted:", error)
        }

        if (!messageStopSeen && !errorSeen) {
          logger.warn(
            "Messages stream ended without completion; sending error event",
          )
          const errorEvent = translateErrorToAnthropicErrorEvent()
          await writeSSEIfConnected(stream, {
            event: errorEvent.type,
            data: JSON.stringify(errorEvent),
          })
        }
      } finally {
        try {
          recordUsage(usage)
          finishMessagesStreamLog({
            response,
            model: anthropicPayload.model,
            chunks,
            completed:
              messageStopSeen
              && !errorSeen
              && !streamInterrupted
              && !stream.aborted
              && !c.req.raw.signal.aborted,
          })
        } finally {
          if (!stream.closed) {
            await stream.close()
          }
        }
      }
    })
  }

  debugJsonTail(logger, "Non-streaming Messages result:", {
    value: response,
    tailLength: 400,
  })
  recordUsage({
    ...normalizeAnthropicUsage(response.usage),
    ...normalizeCopilotUsage(response.copilot_usage),
  })
  return jsonWithForwardedHeaders(response, sourceHeaders)
}

const createCopilotUsageRecorder = (options: {
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string
  model: string
  payload: AnthropicMessagesPayload
}): ((usage: UsageTokens, copilotUsage?: CopilotUsageTokens | null) => void) =>
  createCopilotTokenUsageRecorder({
    endpoint: options.endpoint,
    fallbackSessionId: options.fallbackSessionId,
    model: options.model,
    sessionId: getMetadataSessionId(options.payload),
  })

const getMetadataSessionId = (
  payload: AnthropicMessagesPayload,
): string | null => parseUserIdMetadata(payload.metadata?.user_id).sessionId

const normalizeCopilotUsage = (
  copilotUsage: CopilotUsage | null | undefined,
): UsageTokens => ({
  total_nano_aiu: normalizeOptionalToken(copilotUsage?.total_nano_aiu),
})

const parseAnthropicStreamEvent = (
  data: string,
): AnthropicStreamEventData | null => {
  try {
    return JSON.parse(data) as AnthropicStreamEventData
  } catch {
    return null
  }
}
