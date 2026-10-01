import type { Context } from "hono"

import type { ModelConfig, ResolvedProviderConfig } from "~/lib/config"
import { builtinProviderModelRegistry } from "~/lib/builtin-provider-models"
import { applyForwardableResponseHeaders } from "~/lib/response-headers"
import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"
import type { ResponsesStream } from "~/lib/types/responses"
import consola from "consola"

// 本地观察：normalizeOpenAICompatibleReasoningContent 会删除其访问的每条
// assistant 消息的 reasoning_text/reasoning_opaque，丢弃计数可由调用前输入
// 直接得出，上游函数体因此不含本地行。
export const countReasoningTextOpaqueDrops = (
  messages: ChatCompletionsPayload["messages"],
): number => {
  let dropped = 0
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue
    }
    if (
      message.reasoning_text !== undefined
      || message.reasoning_opaque !== undefined
    ) {
      dropped++
    }
  }
  return dropped
}

export const describeReasoningTextOpaqueDrops = (
  reasoningField: string,
  dropped: number,
): string =>
  `drop thinking block, reason: openai-compatible provider does not recognize reasoning_text/reasoning_opaque; deleted after mapping to ${reasoningField} in ${dropped} message(s)`

// 此处仅用于日志，字段选择需与 normalizeOpenAICompatibleReasoningContent 相同。
const resolveOpenAICompatibleReasoningField = (
  model: string,
  modelConfig: ModelConfig | undefined,
  providerConfig: ResolvedProviderConfig,
): string =>
  modelConfig?.reasoningField
  ?? builtinProviderModelRegistry.getModelConfig(providerConfig.name, model)
    ?.reasoningField
  ?? "reasoning_content"

export const logReasoningTextOpaqueDrops = (options: {
  messages: ChatCompletionsPayload["messages"]
  model: string
  modelConfig: ModelConfig | undefined
  providerConfig: ResolvedProviderConfig
}): void => {
  const dropped = countReasoningTextOpaqueDrops(options.messages)
  if (dropped === 0) {
    return
  }
  consola.info(
    describeReasoningTextOpaqueDrops(
      resolveOpenAICompatibleReasoningField(
        options.model,
        options.modelConfig,
        options.providerConfig,
      ),
      dropped,
    ),
  )
}

export const dropUnsupportedThinkingBudget = (
  payload: ChatCompletionsPayload,
): void => {
  if (payload.thinking_budget !== undefined) {
    delete payload.thinking_budget
    consola.info(
      "drop thinking config, reason: provider does not support thinking_budget; removed before forwarding",
    )
  }
}

export const forwardResponsesStreamHeaders = (
  c: Context,
  upstreamResponse: ResponsesStream,
): void => {
  if (!("headers" in upstreamResponse)) {
    return
  }
  const headers = upstreamResponse.headers as Headers
  applyForwardableResponseHeaders(c, headers)
}
