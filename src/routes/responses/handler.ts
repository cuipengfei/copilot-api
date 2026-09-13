import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import {
  isResponsesApiWebSearchEnabled as isConfiguredResponsesApiWebSearchEnabled,
  resolveEffortForLog,
  resolveMappedModel,
} from "~/lib/config"
import { HTTPError } from "~/lib/error"
import {
  colorizeModel,
  createHandlerLogger,
  debugJson,
  debugJsonTail,
  resolvePremiumInfo,
  shouldUseColor,
  writeStreamLog,
} from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { resolveConfiguredProviderModelAlias } from "~/lib/provider-resolver"
import {
  applyForwardableResponseHeaders,
  getAttachedResponseHeaders,
  jsonWithForwardedHeaders,
} from "~/lib/response-headers"
import { writeSSEIfConnected } from "~/lib/sse"
import { isCodexUserAgent } from "~/routes/models/codex-models"
import {
  handleProviderResponsesForProvider,
  providerResponsesHandlerDependencies,
} from "~/routes/provider/responses/handler"
import {
  createCopilotTokenUsageRecorder,
  copilotUsageFromResponsesEvent,
  copilotUsageToTokens,
  normalizeOptionalToken,
  normalizeResponsesUsage,
  type CopilotUsageTokens,
  type UsageTokens,
} from "~/lib/token-usage"
import {
  generateRequestIdFromPayload,
  getUUID,
  isAsyncIterable,
} from "~/lib/utils"
import type { SubagentMarker } from "~/lib/subagent"
import type {
  Reasoning,
  ResponsesPayload,
  ResponsesResult,
  ResponsesTransport,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import { createResponses as createCopilotResponses } from "~/services/copilot/create-responses"

import { handleResponsesViaMessages } from "./messages-handler"
import { handleResponsesViaChatCompletions } from "./chat-handler"
import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  filterReasoningForTransport,
  getResponsesTransportForModel,
  getResponsesRequestOptions,
  normalizeInputImageDetails,
  normalizeResponsesReasoningEffort,
  sanitizeAllInputImages,
  sanitizeOversizedInputImages,
  sanitizeUnsupportedInputFields,
} from "./utils"
import consola from "consola"

const logger = createHandlerLogger("responses-handler")

const cm = (model: string) => (shouldUseColor() ? colorizeModel(model) : model)

export const responsesHandlerDependencies = {
  createResponses: createCopilotResponses,
  findEndpointModel,
  isResponsesApiWebSearchEnabled: isConfiguredResponsesApiWebSearchEnabled,
  resolveMappedModel,
}

export const handleResponses = async (c: Context) => {
  const payload = await c.req.json<ResponsesPayload>()
  const requestedModel = payload.model
  payload.model = responsesHandlerDependencies.resolveMappedModel(payload.model)
  if (payload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }

  const providerModelAlias = await resolveConfiguredProviderModelAlias(
    payload.model,
    providerResponsesHandlerDependencies.resolveProviderConfig,
  )
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    return await handleProviderResponsesForProvider(c, {
      payload,
      provider: providerModelAlias.provider,
      publicModel: requestedModel,
    })
  }

  debugJson(logger, "Responses request payload:", payload)

  const subagentMarker = getCodexResponsesSubagentMarker(c)
  if (subagentMarker) {
    debugJson(logger, "Detected Codex subagent headers:", subagentMarker)
  }

  const incomingSessionId = getIncomingResponsesSessionId(c)
  const sessionId = incomingSessionId ? getUUID(incomingSessionId) : undefined
  const requestId = generateRequestIdFromPayload(
    { messages: payload.input },
    sessionId,
  )
  logger.debug("Generated request ID:", requestId)

  const fallbackSessionId = sessionId ?? getUUID(requestId)
  logger.debug("Extracted session ID:", fallbackSessionId)
  const selectedModel = responsesHandlerDependencies.findEndpointModel(
    payload.model,
  )
  payload.model = selectedModel?.id ?? payload.model
  const normalizedReasoningEffort = normalizeResponsesReasoningEffort(
    payload,
    selectedModel?.capabilities?.supports?.reasoning_effort,
  )
  if (normalizedReasoningEffort) {
    logger.debug(
      `Normalized reasoning effort from ${normalizedReasoningEffort.from} to ${normalizedReasoningEffort.to} based on the selected model capabilities`,
    )
  }
  const responsesTransport = getResponsesTransportForModel(selectedModel)

  const fallback = getFallback(
    c,
    payload.model,
    selectedModel,
    responsesTransport,
  )
  if (fallback === "messages") {
    filterReasoningForTransport(payload, true)
    return await handleResponsesViaMessages(c, {
      payload,
      publicModel: requestedModel,
      targetModel: payload.model,
      subagentMarker,
      requestId,
      sessionId: fallbackSessionId,
    })
  }
  if (fallback === "chat") {
    return await handleResponsesViaChatCompletions(c, {
      clientSignal: c.req.raw.signal,
      payload,
      subagentMarker,
      requestId,
      sessionId: fallbackSessionId,
    })
  }

  if (!responsesTransport) {
    return c.json(
      {
        error: {
          message:
            "This model does not support the responses endpoint. Please choose a different model.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  filterReasoningForTransport(payload, false)

  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "responses",
    fallbackSessionId,
    model: payload.model,
  })

  const sanitizedUnsupportedFieldCount = sanitizeUnsupportedInputFields(payload)
  if (sanitizedUnsupportedFieldCount > 0) {
    logger.debug(
      `Removed ${sanitizedUnsupportedFieldCount} unsupported input field(s) before forwarding to Copilot Responses`,
    )
  }

  const normalizedImageDetailCount = normalizeInputImageDetails(payload)
  if (normalizedImageDetailCount > 0) {
    logger.debug(
      `Normalized ${normalizedImageDetailCount} unsupported input image detail value(s) before forwarding to Copilot Responses`,
    )
  }

  removeUnsupportedTools(payload)
  fillEmptyNamespaceToolDescriptions(payload)

  if (!responsesHandlerDependencies.isResponsesApiWebSearchEnabled()) {
    removeWebSearchTool(payload)
  }

  const sanitizedImageCount = sanitizeOversizedInputImages(
    payload,
    selectedModel?.capabilities.limits.vision?.max_prompt_image_size,
  )
  if (sanitizedImageCount > 0) {
    logger.warn(
      `Omitted ${sanitizedImageCount} oversized input image(s) before forwarding to Copilot Responses`,
    )
  }

  // Smaller than the client compaction threshold, use server-side compaction to maintain cache hit rate
  const maxPromptTokens = selectedModel?.capabilities.limits.max_prompt_tokens
  const shouldCompactInput = applyResponsesApiContextManagement(
    payload,
    maxPromptTokens,
    {
      compactThresholdRatio: 0.8,
      source: "responses",
    },
  )
  if (shouldCompactInput) {
    compactInputByLatestCompaction(payload)
  }

  debugJson(logger, "Translated Responses payload:", payload)

  const effortForLog = ensureReasoningEffort(payload)
  consola.info(
    `IN ${cm(payload.model)} [effort=${effortForLog.value} (${effortForLog.source})]`,
  )

  const { vision, initiator: inferredInitiator } =
    getResponsesRequestOptions(payload)
  const initiator = subagentMarker ? "agent" : inferredInitiator

  const responseOptions = {
    vision,
    initiator,
    subagentMarker,
    requestId,
    sessionId: fallbackSessionId,
    clientSignal: c.req.raw.signal,
    transport: responsesTransport,
  }

  let response: Awaited<ReturnType<typeof createCopilotResponses>>
  try {
    response = await responsesHandlerDependencies.createResponses(
      payload,
      responseOptions,
    )
  } catch (error) {
    if (!(error instanceof HTTPError) || error.response.status !== 413) {
      throw error
    }

    const retrySanitizedImageCount = sanitizeAllInputImages(payload)
    if (retrySanitizedImageCount === 0) {
      throw error
    }

    logger.warn(
      `Omitted ${retrySanitizedImageCount} input image(s) after Copilot Responses rejected the payload as too large`,
    )
    response = await responsesHandlerDependencies.createResponses(payload, {
      ...responseOptions,
      vision: getResponsesRequestOptions(payload).vision,
    })
  }

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    logger.debug("Forwarding native Responses stream")
    const sourceHeaders = getAttachedResponseHeaders(response)
    applyForwardableResponseHeaders(c, sourceHeaders)
    return streamSSE(c, async (stream) => {
      const idTracker = createStreamIdTracker()
      let chunkCount = 0
      let usage: UsageTokens = {}
      let copilotUsage: CopilotUsageTokens = {}
      const iterator = response[Symbol.asyncIterator]()

      try {
        for await (const chunk of {
          [Symbol.asyncIterator]: () => iterator,
        }) {
          debugJson(logger, "Responses stream chunk:", chunk)
          chunkCount++
          const parsedEvent = parseResponsesStreamEvent(chunk)
          if (
            parsedEvent?.type === "response.completed"
            || parsedEvent?.type === "response.failed"
            || parsedEvent?.type === "response.incomplete"
          ) {
            usage = {
              ...normalizeResponsesUsage(parsedEvent.response.usage),
              total_nano_aiu: normalizeOptionalToken(
                parsedEvent.copilot_usage?.total_nano_aiu,
              ),
            }
            copilotUsage =
              copilotUsageFromResponsesEvent(parsedEvent) ?? copilotUsage
          }

          const processedData = fixStreamIds(
            (chunk as { data?: string }).data ?? "",
            (chunk as { event?: string }).event,
            idTracker,
          )

          await writeSSEIfConnected(stream, {
            id: (chunk as { id?: string }).id,
            event: (chunk as { event?: string }).event,
            data: processedData,
          })
        }
      } catch (err) {
        await writeResponsesStreamError(
          stream,
          createResponsesStreamErrorEvent(payload.model, err),
        )
      } finally {
        await iterator.return?.()
        const premium = await resolvePremiumInfo(response, "responses/stream")
        writeStreamLog(
          { model: payload.model, chunks: chunkCount, done: true, premium },
          true,
        )
        recordUsage(usage, copilotUsage)
        if (!stream.closed) {
          await stream.close()
        }
      }
    })
  }

  debugJsonTail(logger, "Forwarding native Responses result:", {
    value: response,
    tailLength: 400,
  })
  const result = response as ResponsesResult
  recordUsage(
    {
      ...normalizeResponsesUsage(result.usage),
      total_nano_aiu: normalizeOptionalToken(
        result.copilot_usage?.total_nano_aiu,
      ),
    },
    copilotUsageToTokens(result.copilot_usage),
  )
  const premium = await resolvePremiumInfo(response, "responses/non-stream")
  writeStreamLog({ model: payload.model, chunks: 0, done: true, premium }, true)
  return jsonWithForwardedHeaders(result, getAttachedResponseHeaders(response))
}

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const getFallback = (
  c: Context,
  modelId: string,
  selectedModel: { supported_endpoints?: Array<string> } | undefined,
  responsesTransport: ResponsesTransport | null,
): "chat" | "messages" | null => {
  if (isCodexUserAgent(c.req.header("user-agent"))) {
    return !(modelId.startsWith("gpt") || modelId.startsWith("codex")) ?
        "messages"
      : null
  }

  if (responsesTransport) {
    return null
  }

  const supportedEndpoints = selectedModel?.supported_endpoints ?? []
  if (supportedEndpoints.includes("/v1/messages")) return "messages"
  if (
    supportedEndpoints.includes("/chat/completions")
    || supportedEndpoints.includes("/v1/chat/completions")
  ) {
    return "chat"
  }
  return null
}

const parseResponsesStreamEvent = (
  chunk: unknown,
): ResponseStreamEvent | null => {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") {
    return null
  }

  try {
    return JSON.parse(data) as ResponseStreamEvent
  } catch {
    return null
  }
}

const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}

const COPILOT_UNSUPPORTED_TOOL_TYPES = new Set(["image_generation"])
const COPILOT_UNSUPPORTED_TOOL_NAMESPACES = new Set(["image_gen"])

export const removeUnsupportedTools = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  const dropped: Array<string> = []
  payload.tools = payload.tools.filter((t) => {
    const type = t.type as string
    const name = "name" in t && typeof t.name === "string" ? t.name : undefined
    const isUnsupportedNamespace =
      type === "namespace"
      && name !== undefined
      && COPILOT_UNSUPPORTED_TOOL_NAMESPACES.has(name)
    if (COPILOT_UNSUPPORTED_TOOL_TYPES.has(type) || isUnsupportedNamespace) {
      dropped.push(isUnsupportedNamespace ? `${type}:${name}` : type)
      return false
    }
    return true
  })
  if (dropped.length > 0) {
    logger.debug("Removed unsupported tools:", dropped)
  }
}

export const fillEmptyNamespaceToolDescriptions = (
  payload: ResponsesPayload,
): void => {
  fillEmptyNamespaceDescriptions(payload.tools)

  if (!Array.isArray(payload.input)) return

  for (const item of payload.input) {
    if (!item || typeof item !== "object") continue
    fillEmptyNamespaceDescriptions((item as Record<string, unknown>).tools)
  }
}

const fillEmptyNamespaceDescriptions = (tools: unknown): void => {
  if (!Array.isArray(tools)) return

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue

    const namespaceTool = tool as Record<string, unknown>
    if (
      namespaceTool.type === "namespace"
      && namespaceTool.description === ""
      && typeof namespaceTool.name === "string"
    ) {
      namespaceTool.description = namespaceTool.name
    }
  }
}

const getIncomingResponsesSessionId = (c: Context): string | undefined =>
  getTrimmedHeader(c, "session-id") ?? getTrimmedHeader(c, "x-session-id")

const codexSubagentHeaderValues = new Set([
  "collab_spawn",
  "compact",
  "memory_consolidation",
  "review",
])

const getCodexResponsesSubagentMarker = (c: Context): SubagentMarker | null => {
  const agentType = getTrimmedHeader(c, "x-openai-subagent")
  if (!agentType || !codexSubagentHeaderValues.has(agentType)) {
    return null
  }

  const threadId = getTrimmedHeader(c, "thread-id")
  const rootSessionId = getIncomingResponsesSessionId(c)
  const parentThreadId = getTrimmedHeader(c, "x-codex-parent-thread-id")
  if (!threadId && !rootSessionId && !parentThreadId) {
    return null
  }

  const agentId = threadId ?? parentThreadId ?? rootSessionId ?? agentType

  return {
    agent_id: agentId,
    agent_type: agentType,
    session_id: threadId ?? rootSessionId ?? agentId,
  }
}

const getTrimmedHeader = (c: Context, name: string): string | undefined => {
  const value = c.req.header(name)?.trim()
  return value || undefined
}

const ensureReasoningEffort = (
  payload: ResponsesPayload,
): ReturnType<typeof resolveEffortForLog> => {
  const effortForLog = resolveEffortForLog(
    payload.reasoning?.effort ?? undefined,
    payload.model,
  )

  if (!payload.reasoning?.effort) {
    payload.reasoning = {
      ...payload.reasoning,
      effort: effortForLog.value as NonNullable<Reasoning>["effort"],
    }
  }

  return effortForLog
}

const createResponsesStreamErrorEvent = (model: string, err: unknown) => {
  const message = err instanceof Error ? err.message : "Stream error"
  return {
    type: "response.failed",
    sequence_number: 0,
    response: {
      id: "resp_stream_error",
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model,
      output: [],
      output_text: "",
      status: "failed",
      error: { message },
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: "auto",
      tools: [],
      top_p: null,
      usage: null,
    },
  }
}

const writeResponsesStreamError = async (
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  errorEvent: ReturnType<typeof createResponsesStreamErrorEvent>,
) => {
  await writeSSEIfConnected(stream, {
    event: errorEvent.type,
    data: JSON.stringify(errorEvent),
  }).catch(() => {
    // stream already closed
  })
}
