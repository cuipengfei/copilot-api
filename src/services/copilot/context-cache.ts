import type {
  ChatCompletionsPayload,
  CopilotCacheControl,
  Message,
} from "~/lib/types/chat-completions"

const COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT = 2
const COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT = 1
const COPILOT_CONTEXT_CACHE_CONTROL: CopilotCacheControl = {
  type: "ephemeral",
}

export const applyCopilotContextCache = (
  payload: ChatCompletionsPayload,
): void => {
  const messageIndexes = selectCopilotContextCacheMessageIndexes(
    payload.messages,
  )
  for (const messageIndex of messageIndexes) {
    const message = payload.messages[messageIndex]
    message.copilot_cache_control ??= { ...COPILOT_CONTEXT_CACHE_CONTROL }
  }
}

const selectCopilotContextCacheMessageIndexes = (
  messages: Array<Message>,
): Array<number> => {
  const systemIndexes = messages
    .flatMap((message, index) =>
      message.role === "system" && isCopilotContextCacheEligible(message) ?
        [index]
      : [],
    )
    .slice(0, COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT)
  const reverseNonSystemIndexes = messages
    .flatMap((message, index) =>
      message.role !== "system" && isCopilotContextCacheEligible(message) ?
        [index]
      : [],
    )
    .reverse()
    .slice(0, COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT)

  return [...systemIndexes, ...reverseNonSystemIndexes].sort((a, b) => a - b)
}

const isCopilotContextCacheEligible = (message: Message): boolean => {
  if (typeof message.content === "string") {
    return message.content.length > 0
  }

  return Array.isArray(message.content) && message.content.length > 0
}
