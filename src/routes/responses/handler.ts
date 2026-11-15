import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { SubagentMarker } from "~/lib/subagent"

import {
  isResponsesApiWebSearchEnabled as isConfiguredResponsesApiWebSearchEnabled,
  resolveMappedModel,
} from "~/lib/config"
import {
  createHandlerLogger,
  debugJson,
  debugJsonTail,
  writeStreamLog,
} from "~/lib/logger"
import { recordResponsesFirstToken } from "~/lib/first-token"
import { findEndpointModel } from "~/lib/models"
import { resolveConfiguredProviderModelAlias } from "~/lib/provider-resolver"
import { getReasoningReplayIdentity } from "~/lib/reasoning-replay"
import { requestContext } from "~/lib/request-context"
import { setPluginRequestModel } from "~/lib/request-events"
import { readResponsesStreamEvent } from "~/lib/responses-stream-event"
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
  mergeCopilotUsage,
  normalizeResponsesUsage,
  type CopilotUsageTokens,
  type UsageTokens,
} from "~/lib/token-usage"
import {
  generateRequestIdFromPayload,
  getUUID,
  isResponsesStream,
} from "~/lib/utils"
import type {
  ResponsesPayload,
  ResponsesResult,
  ResponsesTransport,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import { createResponses as createCopilotResponses } from "~/services/copilot/create-responses"

import { handleResponsesViaMessages } from "./messages-handler"
import { handleResponsesViaChatCompletions } from "./chat-handler"
import {
  applyForwardableResponseHeaders,
  getAttachedResponseHeaders,
  jsonWithForwardedHeaders,
  logResponsesCompletion,
  prepareNativeResponsesRequest,
  retryResponsesWithoutImages,
  shouldUseChatFallback,
} from "./local-behavior"
import { createResponsesStreamTerminalTracker } from "./stream-failure"
import {
  createCopilotResponsesSseMessage,
  createStreamIdTracker,
} from "./stream-id-sync"
import { getCodexTaskTitleModel } from "./task-title"
import {
  applyDefaultReasoningSummary,
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  filterReasoningForTransport,
  getResponsesTransportForModel,
  getResponsesRequestOptions,
  normalizeGuardianAgentMessages,
  normalizeInputImageDetails,
  normalizeResponsesReasoningEffort,
  sanitizeOversizedInputImages,
  sanitizeUnsupportedInputFields,
} from "./utils"
import consola from "consola"

const logger = createHandlerLogger("responses-handler")

export const responsesHandlerDependencies = {
  createResponses: createCopilotResponses,
  findEndpointModel,
  isResponsesApiWebSearchEnabled: isConfiguredResponsesApiWebSearchEnabled,
  resolveMappedModel,
}

export const handleResponses = async (c: Context) => {
  const payload = await c.req.json<ResponsesPayload>()
  setPluginRequestModel(payload.model)
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

  const taskTitleModel = getCodexTaskTitleModel(
    c.req.header("user-agent"),
    payload.input,
    "copilot",
  )
  if (taskTitleModel) payload.model = taskTitleModel
  const publicModel = taskTitleModel ?? requestedModel

  debugJson(logger, "Responses request payload:", payload)

  const store = requestContext.getStore()
  const rootSessionId = store?.rootSessionId
  const sessionAffinity = store?.sessionAffinity

  // Dispatch-identified subagent (or explicit main) wins; fall back to the
  // Codex subagent header only when the dispatch evidence is inconclusive.
  const storeSubagent = store?.subagent
  const subagentMarker =
    storeSubagent !== undefined ? storeSubagent : (
      getCodexResponsesSubagentMarker(c, { rootSessionId, sessionAffinity })
    )
  if (subagentMarker) {
    debugJson(logger, "Detected subagent session:", subagentMarker)
  }

  const sessionId = rootSessionId ? getUUID(rootSessionId) : undefined
  const requestId =
    sessionAffinity ?
      getUUID(sessionAffinity + "_")
    : generateRequestIdFromPayload({ messages: payload.input }, sessionId)
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

  if (
    shouldUseChatFallback({
      userAgent: c.req.header("user-agent"),
      selectedModel,
      responsesTransport,
    })
  ) {
    return await handleResponsesViaChatCompletions(c, {
      clientSignal: c.req.raw.signal,
      payload,
      subagentMarker,
      requestId,
      sessionId: fallbackSessionId,
    })
  }

  const useMessagesFallback = shouldFallbackToMessages(
    c,
    payload.model,
    selectedModel,
    responsesTransport,
  )
  if (useMessagesFallback) {
    filterReasoningForTransport(payload, true)
    return await handleResponsesViaMessages(c, {
      payload,
      publicModel,
      targetModel: payload.model,
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

  const normalizedAgentMessageCount = normalizeGuardianAgentMessages(payload)
  if (normalizedAgentMessageCount > 0) {
    logger.debug(
      `Translated ${normalizedAgentMessageCount} Guardian agent message(s) to user messages before forwarding to Copilot Responses`,
    )
  }

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

  prepareNativeResponsesRequest({
    payload,
    supportedEfforts: selectedModel?.capabilities?.supports?.reasoning_effort,
  })
  // Summary defaults apply only after configured effort resolution, keeping
  // any explicit client-provided reasoning.summary.
  applyDefaultReasoningSummary(payload)

  const { vision, initiator: inferredInitiator } =
    getResponsesRequestOptions(payload)
  const initiator = subagentMarker ? "agent" : inferredInitiator

  const reasoningReplayIdentity = getReasoningReplayIdentity(
    c.req.raw.headers,
    payload.prompt_cache_key,
  )

  const responseOptions = {
    vision,
    initiator,
    subagentMarker,
    requestId,
    sessionId: fallbackSessionId,
    clientSignal: c.req.raw.signal,
    transport: responsesTransport,
    reasoningReplayIdentity,
  }

  const response = await responsesHandlerDependencies
    .createResponses(payload, responseOptions)
    .catch((error: unknown) =>
      retryResponsesWithoutImages({
        error,
        payload,
        retry: () =>
          responsesHandlerDependencies.createResponses(payload, {
            ...responseOptions,
            vision: getResponsesRequestOptions(payload).vision,
          }),
      }),
    )

  if (isStreamingRequested(payload) && isResponsesStream(response)) {
    logger.debug("Forwarding native Responses stream")
    const sourceHeaders = getAttachedResponseHeaders(response)
    applyForwardableResponseHeaders(c, sourceHeaders)
    return streamSSE(c, async (stream) => {
      const idTracker = createStreamIdTracker()
      let chunkCount = 0
      let terminalEventType: ResponseStreamEvent["type"] | undefined
      let terminalForwarded = false
      let streamErrored = false
      let upstreamErrored = false
      const terminalTracker = createResponsesStreamTerminalTracker(publicModel)
      let usage: UsageTokens = {}
      let copilotUsage: CopilotUsageTokens = {}
      const iterator = response[Symbol.asyncIterator]()

      try {
        while (true) {
          const { value: chunk, done } = await iterator.next()
          if (done) break
          debugJson(logger, "Responses stream chunk:", chunk)
          chunkCount++
          writeStreamLog({
            model: payload.model,
            chunks: chunkCount,
            done: false,
          })
          let parsedEvent: ResponseStreamEvent | null
          try {
            parsedEvent = readResponsesStreamEvent(chunk)
          } catch (error) {
            streamErrored = true
            terminalTracker.observeLocalFailure(error)
            continue
          }
          terminalTracker.observe(parsedEvent)
          recordResponsesFirstToken(parsedEvent)
          if (!terminalForwarded && parsedEvent?.type === "error")
            upstreamErrored = true
          if (
            parsedEvent?.type === "response.completed"
            || parsedEvent?.type === "response.failed"
            || parsedEvent?.type === "response.incomplete"
          ) {
            if (parsedEvent.response.usage) {
              usage = normalizeResponsesUsage(parsedEvent.response.usage)
            }
            copilotUsage = mergeCopilotUsage(
              copilotUsage,
              copilotUsageFromResponsesEvent(parsedEvent) ?? {},
            )
            if (
              terminalForwarded
              || streamErrored
              || (upstreamErrored
                && (parsedEvent.type === "response.completed"
                  || parsedEvent.type === "response.incomplete"))
            ) {
              continue
            }
          }
          if (terminalForwarded || streamErrored) continue

          try {
            const forwarded = await writeSSEIfConnected(
              stream,
              createCopilotResponsesSseMessage(chunk, parsedEvent, idTracker),
              parsedEvent?.type,
            )
            if (
              forwarded
              && parsedEvent
              && (parsedEvent.type === "response.completed"
                || parsedEvent.type === "response.failed"
                || parsedEvent.type === "response.incomplete")
            ) {
              terminalForwarded = true
              terminalEventType = parsedEvent.type
            }
          } catch (error) {
            streamErrored = true
            terminalTracker.observeLocalFailure(error)
          }
        }
      } catch (err) {
        // Record only; the single finalize exit below emits the failure.
        streamErrored = true
        terminalTracker.observeLocalFailure(err)
      } finally {
        let iteratorClosed = false
        try {
          await iterator.return?.()
          iteratorClosed = true
        } catch (err) {
          streamErrored = true
          terminalTracker.observeLocalFailure(err)
        } finally {
          try {
            recordUsage(usage, copilotUsage)
            const failure =
              terminalForwarded ? null : (
                terminalTracker.finalize(idTracker.responseId)
              )
            if (failure && (await writeSSEIfConnected(stream, failure.sse))) {
              logger.warn(
                `Responses stream ended without a terminal event; sent response.failed (${failure.code}: ${failure.message})`,
              )
              writeStreamLog(
                { model: payload.model, chunks: chunkCount, done: false },
                true,
              )
            } else if (
              !upstreamErrored
              && !streamErrored
              && iteratorClosed
              && terminalEventType === "response.completed"
              && !stream.aborted
              && !c.req.raw.signal.aborted
            ) {
              logResponsesCompletion({
                model: payload.model,
                response,
                chunks: chunkCount,
              })
            } else if (chunkCount > 0) {
              writeStreamLog(
                { model: payload.model, chunks: chunkCount, done: false },
                true,
              )
            }
          } finally {
            if (!stream.closed) await stream.close()
          }
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
  if (result.status === "completed") {
    logResponsesCompletion({
      model: payload.model,
      response,
      chunks: 0,
    })
  }
  return jsonWithForwardedHeaders(result, getAttachedResponseHeaders(response))
}

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const shouldFallbackToMessages = (
  c: Context,
  modelId: string,
  selectedModel: { supported_endpoints?: Array<string> } | undefined,
  responsesTransport: ResponsesTransport | null,
): boolean => {
  if (isCodexUserAgent(c.req.header("user-agent"))) {
    return !(modelId.startsWith("gpt") || modelId.startsWith("codex"))
  }

  if (responsesTransport) {
    return false
  }

  const supportedEndpoints = selectedModel?.supported_endpoints ?? []
  return (
    supportedEndpoints.includes("/v1/messages")
    || supportedEndpoints.includes("/chat/completions")
  )
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

const codexSubagentHeaderValues = new Set([
  "collab_spawn",
  "compact",
  "memory_consolidation",
  "review",
])

// Fallback when the dispatch subagent evidence is inconclusive: a Codex
// subagent header paired with the current session affinity marks the request.
const getCodexResponsesSubagentMarker = (
  c: Context,
  session: { rootSessionId?: string; sessionAffinity?: string },
): SubagentMarker | null => {
  const agentType = getTrimmedHeader(c, "x-openai-subagent")
  if (!agentType || !codexSubagentHeaderValues.has(agentType)) {
    return null
  }

  const { rootSessionId, sessionAffinity } = session
  if (!sessionAffinity) {
    return null
  }

  return {
    agent_id: sessionAffinity,
    agent_type: agentType,
    session_id: rootSessionId ?? sessionAffinity,
  }
}

const getTrimmedHeader = (c: Context, name: string): string | undefined => {
  const value = c.req.header(name)?.trim()
  return value || undefined
}
