import { afterEach, expect, test, mock } from "bun:test"

afterEach(() => {
  mock.restore()
})

test("requires model in URL for stream endpoint", async () => {
  const { server } = await import("~/server")
  const res = await server.request("/v1beta/models/:streamGenerateContent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    }),
  })

  expect(res.status).toBe(500)
  const txt = await res.text()
  expect(txt.includes("Model name is required in URL path")).toBe(true)
})
