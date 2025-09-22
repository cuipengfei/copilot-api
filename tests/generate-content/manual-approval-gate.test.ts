import { afterEach, expect, test, mock } from "bun:test"

afterEach(() => {
  mock.restore()
})

test("optional manual approval gate triggers before downstream call", async () => {
  const calls: Array<string> = []
  await mock.module("~/lib/state", () => ({
    state: { manualApprove: true },
  }))
  await mock.module("~/lib/approval", () => ({
    awaitApproval: () => {
      calls.push("approve")
    },
  }))
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: () => {
      calls.push("create")
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

  expect(res.status).toBe(200)
  expect(calls).toEqual(["approve", "create"])
})
