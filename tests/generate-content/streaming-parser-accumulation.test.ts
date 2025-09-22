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

test("accumulates and parses partial JSON chunks", async () => {
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: (_: unknown) => {
      const firstChunk = {
        id: "c1",
        choices: [
          { index: 0, delta: { content: "hello" }, finish_reason: null },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
      const json = JSON.stringify(firstChunk)
      const mid = Math.floor(json.length / 2)
      const finishChunk = {
        id: "c1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }
      return asyncIterableFrom([
        { data: json.slice(0, mid) },
        { data: json.slice(mid) },
        { data: JSON.stringify(finishChunk) },
        { data: "[DONE]" },
      ])
    },
  }))

  await mock.module("~/lib/rate-limit", () => ({
    checkRateLimit: (_: unknown) => {},
  }))
  const { server } = await import("~/server?streaming-parser-accumulation")
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

  const helloCount = (body.match(/hello/g) || []).length
  expect(helloCount).toBe(1)

  expect(body.includes('"finishReason":"STOP"')).toBe(true)
  expect(body.includes("data:")).toBe(true)
})
