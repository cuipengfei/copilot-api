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

test("non-stream endpoint rejects streaming response with 500", async () => {
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: (_: unknown) =>
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
  expect(json).toEqual({
    error: {
      message: "Unexpected streaming response for non-streaming endpoint",
      type: "error",
    },
  })
})
