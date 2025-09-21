import { type GeminiCandidate } from "./types"

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
