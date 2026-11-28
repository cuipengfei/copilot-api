import type {
  ChatCompletionsPayload,
  Message,
} from "~/lib/types/chat-completions"
import { state } from "~/lib/state"

const GEMINI_MODEL_FAMILY = /^gemini(?:-|$)/iu
const GEMINI_CACHE_MARKER_LIMIT = 4

type CopilotContextCacheStrategy = "gemini" | "legacy"

export const isCopilotGeminiModel = (modelId: string): boolean => {
  const model = state.models?.data.find((model) => model.id === modelId)
  return (
    model !== undefined && GEMINI_MODEL_FAMILY.test(model.capabilities.family)
  )
}

export const applyCopilotContextCache = (
  payload: ChatCompletionsPayload,
  strategy: CopilotContextCacheStrategy,
): void => {
  const { messages } = payload
  if (strategy === "legacy") {
    let systemMarkers = 0
    let lastNonSystem: Message | undefined
    for (const message of messages) {
      if (!isCopilotContextCacheEligible(message)) continue
      if (message.role !== "system") {
        lastNonSystem = message
      } else if (systemMarkers < 2) {
        message.copilot_cache_control ??= { type: "ephemeral" }
        systemMarkers++
      }
    }
    if (lastNonSystem) {
      lastNonSystem.copilot_cache_control ??= { type: "ephemeral" }
    }
    return
  }

  let remaining = GEMINI_CACHE_MARKER_LIMIT
  for (const message of messages) {
    if (message.copilot_cache_control !== undefined) remaining--
  }
  if (remaining <= 0) return

  let isBelowCurrentUser = true
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    const isCurrentUser = isBelowCurrentUser && message.role === "user"
    const isLastToolResult =
      isBelowCurrentUser
      && message.role === "tool"
      && messages[index + 1]?.role !== "tool"
    if (message.role === "user") isBelowCurrentUser = false
    const isAssistantWithoutTools =
      message.role === "assistant" && !message.tool_calls?.length
    if (
      (isCurrentUser || isLastToolResult || isAssistantWithoutTools)
      && message.copilot_cache_control === undefined
      && isCopilotContextCacheEligible(message)
    ) {
      message.copilot_cache_control = { type: "ephemeral" }
      remaining--
      if (remaining === 0) return
    }
  }

  for (const message of messages) {
    if (message.role !== "system" && message.role !== "user") break
    if (
      message.copilot_cache_control !== undefined
      || !isCopilotContextCacheEligible(message)
    )
      continue
    message.copilot_cache_control = { type: "ephemeral" }
    remaining--
    if (remaining === 0) return
  }
}

const isCopilotContextCacheEligible = (message: Message): boolean => {
  if (typeof message.content === "string") {
    return message.content.length > 0
  }

  return Array.isArray(message.content) && message.content.length > 0
}
