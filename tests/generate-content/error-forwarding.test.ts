import { afterEach, expect, test, mock } from "bun:test"

afterEach(() => {
  mock.restore()
})

test("forwards generic errors as HTTP 500", async () => {
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: () => {
      throw new Error("Internal issue")
    },
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
  const json = await res.json()
  expect(json).toEqual({ error: { message: "Internal issue", type: "error" } })
})
