import type { Context } from "hono"

import consola from "consola"

import type { Model } from "~/lib/types/models"

import { COMPACT_REQUEST } from "~/lib/compact"
import {
  getClaudeAutoModel,
  getSmallModel,
  isMessagesApiEnabled,
  resolveAnthropicEffortForLog,
  resolveMappedModel,
  shouldCompactUseSmallModel,
} from "~/lib/config"
import {
  colorizeModel,
  createHandlerLogger,
  debugJson,
  shouldUseColor,
} from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { resolveConfiguredProviderModelAlias } from "~/lib/provider-resolver"
import { state } from "~/lib/state"
import type { SubagentMarker } from "~/lib/subagent"
import type { TokenUsageEndpoint } from "~/lib/token-usage"
import {
  generateRequestIdFromPayload,
  getRootSessionId,
  getUUID,
} from "~/lib/utils"
import {
  handleProviderMessagesForProvider,
  providerMessagesHandlerDependencies,
} from "~/routes/provider/messages/handler"
import { getResponsesTransportForModel } from "~/routes/responses/utils"

import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
} from "./api-flows"
import {
  applyLastMessageCacheControl,
  getCompactType,
  getLastMessageContentCacheControl,
  isClaudeAutoModelRequest,
  mergeToolResultForClaude,
  normalizeClaudeCodeBillingHeaderInSystem,
  normalizeSystemMessages,
  sanitizeIdeTools,
  stripToolReferenceTurnBoundary,
} from "./preprocess"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"
import { tryHandleWebSearch } from "./web-search/fulfill"

const logger = createHandlerLogger("messages-handler")
const cm = (model: string) => (shouldUseColor() ? colorizeModel(model) : model)

export const messagesFlowHandlers = {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
}

export async function handleCompletion(c: Context) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

  return await handleCompletionPayload(c, anthropicPayload)
}

export interface CompletionPayloadOptions {
  compactType?: ReturnType<typeof getCompactType>
  skipClaudeAutoModel?: boolean
  skipModelMapping?: boolean
  skipWebSearch?: boolean
  usageEndpoint?: TokenUsageEndpoint
  subagentMarker?: SubagentMarker | null
  sessionId?: string
  requestId?: string
}

export async function handleCompletionPayload(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  dispatchOptions: CompletionPayloadOptions = {},
) {
  const requestedModel = anthropicPayload.model
  if (!dispatchOptions.skipModelMapping) {
    anthropicPayload.model = resolveMappedModel(anthropicPayload.model)
  }
  if (anthropicPayload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${anthropicPayload.model}`,
    )
  }

  if (!dispatchOptions.skipWebSearch) {
    const webSearchResult = await tryHandleWebSearch(c, anthropicPayload, {
      logger,
      forwardToProvider: (ctx, payload, provider) =>
        handleProviderMessagesForProvider(ctx, { payload, provider }),
    })
    if (webSearchResult) return webSearchResult
  }

  const claudeAutoModel = getClaudeAutoModel()
  const shouldUseClaudeAutoModel = Boolean(
    !dispatchOptions.skipClaudeAutoModel
    && claudeAutoModel
    && isClaudeAutoModelRequest(anthropicPayload),
  )
  if (claudeAutoModel && shouldUseClaudeAutoModel) {
    consola.debug(
      `Claude auto model override: ${anthropicPayload.model} -> ${claudeAutoModel}`,
    )
    anthropicPayload.model = claudeAutoModel
  }

  const providerModelAlias = await resolveConfiguredProviderModelAlias(
    anthropicPayload.model,
    providerMessagesHandlerDependencies.resolveProviderConfig,
  )
  if (providerModelAlias) {
    anthropicPayload.model = providerModelAlias.model
    return await handleProviderMessagesForProvider(c, {
      payload: anthropicPayload,
      provider: providerModelAlias.provider,
      usageEndpoint: dispatchOptions.usageEndpoint,
    })
  }

  debugJson(logger, "Anthropic request payload:", anthropicPayload)

  normalizeClaudeCodeBillingHeaderInSystem(anthropicPayload)
  normalizeSystemMessages(anthropicPayload)

  const originalModel = anthropicPayload.model

  const compactType =
    dispatchOptions.compactType ?? getCompactType(anthropicPayload)
  if (compactType !== 0) {
    logger.debug("Compact request type:", compactType)
    if (shouldCompactUseSmallModel()) {
      anthropicPayload.model = getSmallModel()
    }
  }
  sanitizeIdeTools(anthropicPayload)

  const subagentMarker =
    dispatchOptions.subagentMarker
    ?? parseSubagentMarkerFromFirstUser(anthropicPayload)
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  let sessionId =
    dispatchOptions.sessionId ?? getRootSessionId(anthropicPayload, c)

  // fix claude code 2.0.28+ warmup request consume premium request, forcing small model if no tools are used
  // set "CLAUDE_CODE_SUBAGENT_MODEL": "you small model" also can avoid this
  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)
  if (!state.tokenBasedBilling && !shouldUseClaudeAutoModel) {
    const tools = anthropicPayload.tools
    const noTools = !tools || tools.length === 0
    if (anthropicBeta && noTools && compactType === 0) {
      const smallModel = getSmallModel()
      consola.debug(
        `Claude Code warmup small model: ${anthropicPayload.model} -> ${smallModel}`,
      )
      anthropicPayload.model = smallModel
    }
  }

  if (!state.tokenBasedBilling) {
    const lastMessageCacheControl = getLastMessageContentCacheControl(
      anthropicPayload.messages.at(-1),
    )

    stripToolReferenceTurnBoundary(anthropicPayload)

    // Merge tool_result and text blocks into tool_result to avoid consuming premium requests
    // (caused by skill invocations, edit hooks, plan or to do reminders)
    // e.g. {"role":"user","content":[{"type":"tool_result","content":"Launching skill: xxx"},{"type":"text","text":"xxx"}]}
    // not only for claude, but also for opencode
    // compact requests still run this processing, except for the final compact message itself
    mergeToolResultForClaude(anthropicPayload, {
      skipLastMessage: compactType === COMPACT_REQUEST,
    })

    applyLastMessageCacheControl(anthropicPayload, lastMessageCacheControl)
  }

  const selectedModel = findEndpointModel(anthropicPayload.model)
  anthropicPayload.model = selectedModel?.id ?? anthropicPayload.model

  const requestId =
    dispatchOptions.requestId
    ?? generateRequestIdFromPayload(anthropicPayload, sessionId)
  logger.debug("Generated request ID:", requestId)

  if (!sessionId) {
    sessionId = getUUID(requestId)
  }
  logger.debug("Extracted session ID:", sessionId)

  const { value: effortValue, source: effortSource } =
    resolveAnthropicEffortForLog(
      anthropicPayload.output_config?.effort,
      anthropicPayload.model,
    )
  consola.info(
    `IN ${cm(originalModel)} → ${cm(anthropicPayload.model)} [effort=${effortValue} (${effortSource})]`,
  )

  if (shouldUseMessagesApi(selectedModel)) {
    return await messagesFlowHandlers.handleWithMessagesApi(
      c,
      anthropicPayload,
      {
        anthropicBetaHeader: anthropicBeta,
        subagentMarker,
        selectedModel,
        requestId,
        sessionId,
        compactType,
        logger,
        usageEndpoint: dispatchOptions.usageEndpoint,
      },
    )
  }

  if (shouldUseResponsesApi(selectedModel, compactType)) {
    return await messagesFlowHandlers.handleWithResponsesApi(
      c,
      anthropicPayload,
      {
        subagentMarker,
        selectedModel,
        requestId,
        sessionId,
        compactType,
        logger,
        usageEndpoint: dispatchOptions.usageEndpoint,
      },
    )
  }

  return await messagesFlowHandlers.handleWithChatCompletions(
    c,
    anthropicPayload,
    {
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      compactType,
      logger,
      usageEndpoint: dispatchOptions.usageEndpoint,
    },
  )
}

const MESSAGES_ENDPOINT = "/v1/messages"

const shouldUseResponsesApi = (
  selectedModel: Model | undefined,
  compactType: ReturnType<typeof getCompactType>,
): boolean => {
  return Boolean(getResponsesTransportForModel(selectedModel, { compactType }))
}

const shouldUseMessagesApi = (selectedModel: Model | undefined): boolean => {
  const useMessagesApi = isMessagesApiEnabled()
  if (!useMessagesApi) {
    return false
  }

  return (
    selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT) ?? false
  )
}
