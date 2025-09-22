import { afterEach, expect, test, mock } from "bun:test"

import type { GeminiRequest } from "~/routes/generate-content/types"

import { translateGeminiToOpenAINonStream } from "~/routes/generate-content/translation"

afterEach(() => {
  mock.restore()
})

function buildPayload(mode: "AUTO" | "ANY" | "NONE"): GeminiRequest {
  return {
    toolConfig: { functionCallingConfig: { mode } },
    contents: [
      { role: "user", parts: [{ text: "hi" }] },
      {
        role: "model",
        parts: [
          { functionCall: { name: "f", args: {} as Record<string, unknown> } },
        ],
      },
    ],
  }
}

test("maps toolConfig AUTO/ANY/NONE to auto/required/none", () => {
  const auto = translateGeminiToOpenAINonStream(
    buildPayload("AUTO"),
    "gemini-pro",
  )
  const any = translateGeminiToOpenAINonStream(
    buildPayload("ANY"),
    "gemini-pro",
  )
  const none = translateGeminiToOpenAINonStream(
    buildPayload("NONE"),
    "gemini-pro",
  )

  const modes = [auto.tool_choice, any.tool_choice, none.tool_choice]
  expect(modes).toEqual(["auto", "required", "none"])
})
