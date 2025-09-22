import { afterEach, expect, test, mock } from "bun:test"

afterEach(() => {
  mock.restore()
})

test("falls back to streaming when downstream returns non-stream JSON", async () => {
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: (_: unknown) => ({
      id: "res-3",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "stream me" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
  }))

  const { server } = await import("~/server")
  const res = await server.request(
    "/v1beta/models/gemini-pro:streamGenerateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      }),
    },
  )

  expect(res.status).toBe(200)
  const ct = res.headers.get("content-type") || ""
  expect(ct.includes("text/event-stream")).toBe(true)
  const body = await res.text()

  expect(body.includes("data:")).toBe(true)
  expect(body.includes("stream me")).toBe(true)
  expect(body.includes('"finishReason":"STOP"')).toBe(true)
  expect(body.includes('"usageMetadata"')).toBe(true)

  const occurrences = (body.match(/stream me/g) || []).length
  expect(occurrences >= 1).toBe(true)
})
