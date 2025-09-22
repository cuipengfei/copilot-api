import { afterEach, expect, test, mock } from "bun:test"

import { HTTPError } from "~/lib/error"

afterEach(() => {
  mock.restore()
})

test("forwards HTTPError with original status and body", async () => {
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: () => {
      const body = JSON.stringify({ detail: "Invalid Key" })
      const resp = new Response(body, {
        status: 401,
        statusText: "Unauthorized",
      })
      throw new HTTPError("Downstream error", resp)
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
  expect(res.status).toBe(401)
  const json = await res.json()
  expect(json).toEqual({
    error: { message: '{"detail":"Invalid Key"}', type: "error" },
  })
})
