import { afterEach, expect, test, mock } from "bun:test"

import type { GeminiRequest } from "~/routes/generate-content/types"
import type { Message } from "~/services/copilot/create-chat-completions"

import { translateGeminiToOpenAINonStream } from "~/routes/generate-content/translation"

afterEach(() => {
  mock.restore()
})

test("merges consecutive same-role user messages with blank separator", () => {
  const payload: GeminiRequest = {
    contents: [
      { role: "user", parts: [{ text: "Hello." }] },
      { role: "user", parts: [{ text: "How are you?" }] },
    ],
  }

  const result = translateGeminiToOpenAINonStream(payload, "gemini-pro")
  const userMsgs = result.messages.filter((m: Message) => m.role === "user")
  expect(userMsgs.length).toBe(1)
  expect(userMsgs[0].content).toBe("Hello.\n\nHow are you?")
})
