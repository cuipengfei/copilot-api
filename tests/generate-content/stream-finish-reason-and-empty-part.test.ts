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

test("includes usageMetadata only on final chunk and injects empty part when only finish_reason", async () => {
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: (_: unknown) =>
      asyncIterableFrom([
        {
          data: JSON.stringify({
            id: "c1",
            choices: [
              { index: 0, delta: { content: "hello" }, finish_reason: null },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        },
        {
          data: JSON.stringify({
            id: "c1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          }),
        },
        { data: "[DONE]" },
      ]),
  }))

  await mock.module("~/lib/rate-limit", () => ({
    checkRateLimit: (_: unknown) => {},
  }))
  const { server } = await import(
    "~/server?stream-finish-reason-and-empty-part"
  )
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

  const usageCount = (body.match(/"usageMetadata"/g) || []).length
  expect(usageCount).toBe(1)

  const finishStop = body.includes('"finishReason":"STOP"')
  expect(finishStop).toBe(true)

  const injectedEmpty = body.includes('"parts":[{"text":""}]')
  expect(injectedEmpty).toBe(true)
})
