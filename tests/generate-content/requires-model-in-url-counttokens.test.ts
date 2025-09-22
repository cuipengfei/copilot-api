import { afterEach, expect, test, mock } from "bun:test"

afterEach(() => {
  mock.restore()
})

test("requires model in URL for countTokens endpoint", async () => {
  const { server } = await import("~/server")
  const res = await server.request("/v1beta/models/:countTokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    }),
  })

  expect(res.status).toBe(500)
  const json = await res.json()
  expect(json).toEqual({
    error: { message: "Model name is required in URL path", type: "error" },
  })
})
