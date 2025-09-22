import { afterEach, expect, test, mock } from "bun:test"

import type { GeminiRequest } from "~/routes/generate-content/types"

import { translateGeminiToOpenAINonStream } from "~/routes/generate-content/translation"

afterEach(() => {
  mock.restore()
})

test("translates request Gemini→OpenAI with stream:false on non-stream endpoint", () => {
  const payload: GeminiRequest = {
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
  }
  const result = translateGeminiToOpenAINonStream(payload, "gemini-pro")
  expect(result.stream).toBe(false)
  expect(Array.isArray(result.messages)).toBe(true)
  expect(result.model).toBeDefined()
})
