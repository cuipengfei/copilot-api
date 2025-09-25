import { afterEach, expect, test, mock } from "bun:test"

afterEach(() => {
  mock.restore()
})

test("streams fallback response when no text content in non-streaming to streaming conversion", async () => {
  // Mock createChatCompletions to return a non-streaming response with no text content
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: (_: unknown) => ({
      id: "res-fallback",
      choices: [
        {
          index: 0,
          // No content, or content that doesn't have text
          message: { role: "assistant", content: null },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    }),
  }))

  await mock.module("~/lib/rate-limit", () => ({
    checkRateLimit: () => {},
  }))

  const { server } = await import("~/server?fallback-response-no-text")

  // Request streaming endpoint, but get non-streaming response with no text
  const res = await server.request(
    "/v1beta/models/gemini-pro:streamGenerateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "test" }] }],
      }),
    },
  )

  expect(res.status).toBe(200)
  const ct = res.headers.get("content-type") || ""
  expect(ct.includes("text/event-stream")).toBe(true)

  const body = await res.text()

  // Should contain data events
  expect(body.includes("data:")).toBe(true)
  // Should have the fallback response structure
  expect(body.includes('"candidates"')).toBe(true)
  expect(body.includes('"usageMetadata"')).toBe(true)
})
