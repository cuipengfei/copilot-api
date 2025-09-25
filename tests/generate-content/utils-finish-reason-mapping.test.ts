import { afterEach, expect, test, mock } from "bun:test"

afterEach(() => {
  mock.restore()
})

import {
  mapOpenAIFinishReasonToGemini,
  mapGeminiFinishReasonToOpenAI,
} from "~/routes/generate-content/utils"

test("maps unknown OpenAI finish reason to FINISH_REASON_UNSPECIFIED", () => {
  const result = mapOpenAIFinishReasonToGemini("unknown_reason")
  expect(result).toBe("FINISH_REASON_UNSPECIFIED")
})

test("maps null OpenAI finish reason to FINISH_REASON_UNSPECIFIED", () => {
  const result = mapOpenAIFinishReasonToGemini(null)
  expect(result).toBe("FINISH_REASON_UNSPECIFIED")
})

test("maps Gemini STOP finish reason to OpenAI stop", () => {
  const result = mapGeminiFinishReasonToOpenAI("STOP")
  expect(result).toBe("stop")
})

test("maps Gemini FINISH_REASON_UNSPECIFIED to OpenAI stop", () => {
  const result = mapGeminiFinishReasonToOpenAI("FINISH_REASON_UNSPECIFIED")
  expect(result).toBe("stop")
})

test("maps Gemini MALFORMED_FUNCTION_CALL to OpenAI stop", () => {
  const result = mapGeminiFinishReasonToOpenAI("MALFORMED_FUNCTION_CALL")
  expect(result).toBe("stop")
})

test("maps Gemini MAX_TOKENS to OpenAI length", () => {
  const result = mapGeminiFinishReasonToOpenAI("MAX_TOKENS")
  expect(result).toBe("length")
})

test("maps Gemini SAFETY to OpenAI content_filter", () => {
  const result = mapGeminiFinishReasonToOpenAI("SAFETY")
  expect(result).toBe("content_filter")
})

test("maps Gemini RECITATION to OpenAI content_filter", () => {
  const result = mapGeminiFinishReasonToOpenAI("RECITATION")
  expect(result).toBe("content_filter")
})

test("maps Gemini BLOCKLIST to OpenAI content_filter", () => {
  const result = mapGeminiFinishReasonToOpenAI("BLOCKLIST")
  expect(result).toBe("content_filter")
})

test("maps Gemini PROHIBITED_CONTENT to OpenAI content_filter", () => {
  const result = mapGeminiFinishReasonToOpenAI("PROHIBITED_CONTENT")
  expect(result).toBe("content_filter")
})

test("maps Gemini SPII to OpenAI content_filter", () => {
  const result = mapGeminiFinishReasonToOpenAI("SPII")
  expect(result).toBe("content_filter")
})

test("maps Gemini IMAGE_SAFETY to OpenAI content_filter", () => {
  const result = mapGeminiFinishReasonToOpenAI("IMAGE_SAFETY")
  expect(result).toBe("content_filter")
})

test("maps undefined Gemini finish reason to OpenAI stop", () => {
  const result = mapGeminiFinishReasonToOpenAI(undefined)
  expect(result).toBe("stop")
})

test("maps unknown Gemini finish reason to OpenAI stop", () => {
  const result = mapGeminiFinishReasonToOpenAI("UNKNOWN_REASON")
  expect(result).toBe("stop")
})
