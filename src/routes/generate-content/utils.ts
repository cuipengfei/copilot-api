import { type GeminiCandidate } from "./types"

const OpenAIFinish = {
  stop: "stop",
  length: "length",
  content_filter: "content_filter",
  tool_calls: "tool_calls",
} as const

const GeminiFinish = {
  FINISH_REASON_UNSPECIFIED: "FINISH_REASON_UNSPECIFIED",
  STOP: "STOP",
  MAX_TOKENS: "MAX_TOKENS",
  SAFETY: "SAFETY",
  RECITATION: "RECITATION",
  BLOCKLIST: "BLOCKLIST",
  PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
  SPII: "SPII",
  IMAGE_SAFETY: "IMAGE_SAFETY",
  MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL",
} as const

export function mapOpenAIFinishReasonToGemini(
  finishReason: string | null,
): GeminiCandidate["finishReason"] {
  switch (finishReason) {
    case OpenAIFinish.stop: {
      return "STOP"
    }
    case OpenAIFinish.length: {
      return "MAX_TOKENS"
    }
    case OpenAIFinish.content_filter: {
      return "SAFETY"
    }
    case OpenAIFinish.tool_calls: {
      return "STOP" // Gemini doesn't have a specific tool_calls finish reason, map to STOP
    }
    default: {
      return GeminiFinish.FINISH_REASON_UNSPECIFIED
    }
  }
}

// Add the reverse mapping - Gemini → OpenAI (based on LiteLLM research)
export function mapGeminiFinishReasonToOpenAI(
  finishReason: string | undefined,
): "stop" | "length" | "content_filter" | "tool_calls" {
  switch (finishReason) {
    case GeminiFinish.STOP:
    case GeminiFinish.FINISH_REASON_UNSPECIFIED:
    case GeminiFinish.MALFORMED_FUNCTION_CALL: {
      return OpenAIFinish.stop
    }
    case GeminiFinish.MAX_TOKENS: {
      return OpenAIFinish.length
    }
    case GeminiFinish.SAFETY:
    case GeminiFinish.RECITATION:
    case GeminiFinish.BLOCKLIST:
    case GeminiFinish.PROHIBITED_CONTENT:
    case GeminiFinish.SPII:
    case GeminiFinish.IMAGE_SAFETY: {
      return OpenAIFinish.content_filter
    }
    default: {
      return OpenAIFinish.stop
    }
  }
}
