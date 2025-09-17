import { type AnthropicResponse } from "./anthropic-types"
import { type GeminiCandidate } from "./gemini-types"

export function mapOpenAIStopReasonToAnthropic(
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): AnthropicResponse["stop_reason"] {
  if (finishReason === null) {
    return null
  }
  const stopReasonMap = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "end_turn",
  } as const
  return stopReasonMap[finishReason]
}

export function mapOpenAIFinishReasonToGemini(
  finishReason: string | null,
): GeminiCandidate["finishReason"] {
  switch (finishReason) {
    case "stop": {
      return "STOP"
    }
    case "length": {
      return "MAX_TOKENS"
    }
    case "content_filter": {
      return "SAFETY"
    }
    case "tool_calls": {
      return "STOP"
    } // Gemini doesn't have a specific tool_calls finish reason
    default: {
      return "FINISH_REASON_UNSPECIFIED"
    }
  }
}
