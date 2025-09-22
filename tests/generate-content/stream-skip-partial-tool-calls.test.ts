import { afterEach, expect, test, mock } from "bun:test"

function asyncIterableFrom(events: Array<{ data?: string }>) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next() {
          if (i < events.length)
            return Promise.resolve({ value: events[i++], done: false })
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
}

afterEach(() => {
  mock.restore()
})

test("[Stream] skips tool_calls with partial JSON arguments until complete", async () => {
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: () =>
      asyncIterableFrom([
        {
          data: JSON.stringify({
            id: "c1",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      type: "function",
                      function: { name: "f", arguments: '{"a":' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        },
        {
          data: JSON.stringify({
            id: "c1",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      type: "function",
                      function: { name: "f", arguments: '{"a":1}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        },
        {
          data: JSON.stringify({
            id: "c1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        },
        { data: "[DONE]" },
      ]),
  }))

  await mock.module("~/lib/rate-limit", () => ({
    checkRateLimit: (_: unknown) => {},
  }))
  const { server } = await import("~/server?stream-skip-partial-tool-calls")
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
  const body = await res.text()

  expect(body.includes('"functionCall":{"name":"f","args"')).toBe(true)
  expect(body.includes('"functionCall":{"name":"f","args":{')).toBe(true)
  expect(body.includes('"functionCall":{"name":"f","args":{')).toBe(true)
  expect(body.includes('"functionCall":{"name":"f","args":{"a":1}')).toBe(true)
})
