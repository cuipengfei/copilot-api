import { afterEach, expect, test, mock } from "bun:test"

import type { GeminiRequest } from "~/routes/generate-content/types"
import type { Tool } from "~/services/copilot/create-chat-completions"

import { translateGeminiToOpenAINonStream } from "~/routes/generate-content/translation"

afterEach(() => {
  mock.restore()
})

test("synthesizes tools when contents include functionCall and tools not provided", () => {
  const payload: GeminiRequest = {
    contents: [
      { role: "user", parts: [{ text: "Do a web search" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "search", args: { query: "cats" } } }],
      },
    ],
  }

  const result = translateGeminiToOpenAINonStream(payload, "gemini-pro")
  const tools: Array<Tool> = result.tools || []
  const names = tools.map((t) => t.function.name)
  expect(names.includes("search")).toBe(true)
})
