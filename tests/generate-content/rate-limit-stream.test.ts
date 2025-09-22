import { afterEach, expect, test, mock } from "bun:test"

function asyncIterableFrom(events: Array<{ data?: string }>) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next() {
          if (i < events.length) return { value: events[i++], done: false }
          return { value: undefined, done: true }
        },
      }
    },
  }
}

afterEach(() => {
  mock.restore()
})

test("enforces rate limit before stream", async () => {
  await mock.module("~/lib/rate-limit", () => ({
    checkRateLimit: () => {
      throw new Error("Rate limited stream")
    },
  }))
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: () =>
      asyncIterableFrom([
        {
          data: JSON.stringify({
            id: "c1",
            choices: [
              { index: 0, delta: { content: "x" }, finish_reason: null },
            ],
          }),
        },
        {
          data: JSON.stringify({
            id: "c1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        },
        { data: "[DONE]" },
      ]),
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

  expect(res.status).toBe(500)
  const txt = await res.text()
  expect(txt.includes("Rate limited stream")).toBe(true)
})
