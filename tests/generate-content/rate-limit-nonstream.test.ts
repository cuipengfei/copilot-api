import { afterEach, expect, test, mock } from "bun:test"

afterEach(() => {
  mock.restore()
})

test("enforces rate limit before processing (non-stream)", async () => {
  await mock.module("~/lib/rate-limit", () => ({
    checkRateLimit: () => {
      throw new Error("Rate limited")
    },
  }))
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: () => {
      return {
        id: "x",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
    },
  }))

  const { server } = await import("~/server")
  const res = await server.request(
    "/v1beta/models/gemini-pro:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      }),
    },
  )

  expect(res.status).toBe(500)
  const json = await res.json()
  expect(json).toEqual({ error: { message: "Rate limited", type: "error" } })
})
