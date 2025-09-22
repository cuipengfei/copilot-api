import { afterEach, expect, test, mock } from "bun:test"

import type { GeminiRequest } from "~/routes/generate-content/types"
import type { Message } from "~/services/copilot/create-chat-completions"

import { translateGeminiToOpenAINonStream } from "~/routes/generate-content/translation"

afterEach(() => {
  mock.restore()
})

test("removes assistant message with tool_calls lacking tool responses", () => {
  const payload: GeminiRequest = {
    contents: [
      { role: "user", parts: [{ text: "Search for cats." }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "search", args: { query: "cats" } } }],
      },
      { role: "user", parts: [{ text: "Show me results." }] },
    ],
  }

  const result = translateGeminiToOpenAINonStream(payload, "gemini-pro")
  const msgs = result.messages
  const assistantMsgs = msgs.filter((m: Message) => m.role === "assistant")
  expect(assistantMsgs.length).toBe(0)
  const userMsgs = msgs.filter((m: Message) => m.role === "user")
  expect(userMsgs.length > 0).toBe(true)
})
