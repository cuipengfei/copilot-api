import { type AnthropicResponse } from "~/lib/types/anthropic"

export function mapOpenAIStopReasonToAnthropic(
  finishReason:
    "stop" | "length" | "tool_calls" | "content_filter" | "error" | null,
): AnthropicResponse["stop_reason"] {
  if (finishReason === null || finishReason === "error") {
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
