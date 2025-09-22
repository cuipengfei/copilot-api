import { afterEach, expect, test, mock } from "bun:test"

import type { GeminiRequest } from "~/routes/generate-content/types"
import type { Tool } from "~/services/copilot/create-chat-completions"

import { translateGeminiToOpenAINonStream } from "~/routes/generate-content/translation"

afterEach(() => {
  mock.restore()
})

test("ignores urlContext tool in tools list", () => {
  const payload: GeminiRequest = {
    tools: [
      { urlContext: {} },
      { functionDeclarations: [{ name: "f", parameters: { type: "object" } }] },
    ],
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
  }

  const result = translateGeminiToOpenAINonStream(payload, "gemini-pro")
  const tools: Array<Tool> = result.tools || []
  const names = new Set(tools.map((t) => t.function.name))
  expect(names.has("f")).toBe(true)
  expect(names.has("urlContext")).toBe(false)
})
