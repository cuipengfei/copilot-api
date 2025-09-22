import { afterEach, expect, test, mock } from "bun:test"

afterEach(() => {
  mock.restore()
})

test("maps finish_reason stop/length/content_filter/tool_calls correctly (non-stream)", async () => {
  const finishCases = [
    { fr: "stop", expected: "STOP" },
    { fr: "length", expected: "MAX_TOKENS" },
    { fr: "content_filter", expected: "SAFETY" },
    { fr: "tool_calls", expected: "STOP" },
  ]

  let idx = 0
  await mock.module("~/services/copilot/create-chat-completions", () => ({
    createChatCompletions: () => {
      const fr = finishCases[idx++].fr as
        | "stop"
        | "length"
        | "content_filter"
        | "tool_calls"
      return {
        id: "x",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: fr,
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }
    },
  }))

  const { server } = await import("~/server")
  for (const finishCase of finishCases) {
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
    const json = (await res.json()) as {
      candidates: [{ finishReason: string }]
    }
    const got = json.candidates[0].finishReason
    expect(got).toBe(finishCase.expected)
  }
})
