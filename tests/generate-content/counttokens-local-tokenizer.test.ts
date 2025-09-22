import { afterEach, expect, test, mock } from "bun:test"

afterEach(() => {
  mock.restore()
})

test("translates request and uses local tokenizer without downstream call", async () => {
  let downstreamCalled = false
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: () => {
      downstreamCalled = true
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
  await mock.module("~/lib/tokenizer", () => ({
    getTokenCount: (_: unknown) => ({ input: 2, output: 3 }),
  }))

  const { server } = await import("~/server")
  const res = await server.request("/v1beta/models/gemini-pro:countTokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    }),
  })

  expect(res.status).toBe(200)
  const json = await res.json()
  expect(json).toEqual({ totalTokens: 5 })
  expect(downstreamCalled).toBe(false)
})
