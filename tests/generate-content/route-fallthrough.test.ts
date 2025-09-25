import { afterEach, expect, test, mock } from "bun:test"

afterEach(() => {
  mock.restore()
})

test("routes fallthrough when URL doesn't match any generate-content patterns", async () => {
  await mock.module("~/lib/rate-limit", () => ({
    checkRateLimit: () => {},
  }))

  const { server } = await import("~/server?route-fallthrough")

  // Test with a URL that doesn't match any of the patterns
  // Not :streamGenerateContent, not :countTokens, not :generateContent
  const res = await server.request(
    "/v1beta/models/gemini-pro:unknownOperation",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "test" }] }],
      }),
    },
  )

  // Should get 404 or similar since no route matches
  expect(res.status).toBe(404)
})
