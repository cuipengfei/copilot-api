import { afterEach, describe, expect, test, mock } from "bun:test"

import {
  makeRequest,
  setupPayloadCapture,
  expectMessageCounts,
  expectUniqueToolCallIds,
  expectToolCallIdFormat,
  GEMINI_PRO_URL,
} from "./_test-utils/integration"

afterEach(() => {
  mock.restore()
})

describe("Translation Integration (Content Processing)", () => {
  test("processes inline data with inlineData field", async () => {
    const capturedPayload = await setupPayloadCapture()
    const res = await makeRequest(GEMINI_PRO_URL, {
      contents: [
        {
          role: "user",
          parts: [
            { text: "Analyze this image" },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
              },
            },
          ],
        },
      ],
    })
    expect(res.status).toBe(200)
    expect(capturedPayload.messages?.length).toBe(1)
    const userMessage = capturedPayload.messages?.[0]
    expect(userMessage?.role).toBe("user")
    const content = userMessage?.content
    expect(content).toBeDefined()
    expect(typeof content === "string" || Array.isArray(content)).toBe(true)
  })

  test("processes function response arrays with tool call matching", async () => {
    const capturedPayload = await setupPayloadCapture()
    const res = await makeRequest(GEMINI_PRO_URL, {
      contents: [
        { role: "user", parts: [{ text: "Call function" }] },
        {
          role: "model",
          parts: [
            { functionCall: { name: "testFunc", args: { param: "value" } } },
          ],
        },
        {
          role: "user",
          parts: [
            [
              {
                functionResponse: {
                  name: "testFunc",
                  response: { result: "success" },
                },
              },
            ],
          ],
        },
      ],
    })
    expect(res.status).toBe(200)
    expect(capturedPayload.messages).toBeInstanceOf(Array)
  })

  test("handles function response without matching tool call", async () => {
    const capturedPayload = await setupPayloadCapture()
    const res = await makeRequest(GEMINI_PRO_URL, {
      contents: [
        { role: "user", parts: [{ text: "Call function" }] },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "testFunc",
                response: { result: "orphan" },
              },
            },
          ],
        },
      ],
    })
    expect(res.status).toBe(200)
    expect(capturedPayload.messages?.length).toBeGreaterThan(0)
  })
})

describe("Translation Integration (Multi-turn)", () => {
  test("handles multi-turn tool call conversation correctly", async () => {
    const capturedPayload = await setupPayloadCapture()
    const res = await makeRequest(GEMINI_PRO_URL, {
      contents: [
        { role: "user", parts: [{ text: "Read file A" }] },
        {
          role: "model",
          parts: [
            { functionCall: { name: "readFile", args: { path: "a.txt" } } },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "readFile",
                response: { content: "Content of A" },
              },
            },
          ],
        },
        { role: "model", parts: [{ text: "File A contains: Content of A" }] },
        { role: "user", parts: [{ text: "Now read file B" }] },
        {
          role: "model",
          parts: [
            { functionCall: { name: "readFile", args: { path: "b.txt" } } },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "readFile",
                response: { content: "Content of B" },
              },
            },
          ],
        },
      ],
    })
    expect(res.status).toBe(200)
    expectMessageCounts(capturedPayload, {
      total: 5,
      assistantWithTools: 2,
      tool: 2,
    })
    expectToolCallIdFormat(capturedPayload)
  })

  test("handles duplicate tool responses by deduplication", async () => {
    const capturedPayload = await setupPayloadCapture()
    const res = await makeRequest(GEMINI_PRO_URL, {
      contents: [
        { role: "user", parts: [{ text: "Call function" }] },
        {
          role: "model",
          parts: [
            { functionCall: { name: "testFunc", args: { param: "value1" } } },
            { functionCall: { name: "testFunc2", args: { param: "value2" } } },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "testFunc",
                response: { result: "first" },
              },
            },
            {
              functionResponse: {
                name: "testFunc2",
                response: { result: "second" },
              },
            },
            {
              functionResponse: {
                name: "testFunc",
                response: { result: "duplicate" },
              },
            },
          ],
        },
      ],
    })
    expect(res.status).toBe(200)
    expectUniqueToolCallIds(capturedPayload, 2)
  })

  test("verifies tool_call_id length constraint (<=40 characters)", async () => {
    const capturedPayload = await setupPayloadCapture()
    const res = await makeRequest(GEMINI_PRO_URL, {
      contents: [
        { role: "user", parts: [{ text: "Call a function" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "veryLongFunctionNameThatMightCauseIssues",
                args: { param: "test" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "veryLongFunctionNameThatMightCauseIssues",
                response: { result: "ok" },
              },
            },
          ],
        },
      ],
    })
    expect(res.status).toBe(200)
    expectToolCallIdFormat(capturedPayload)
  })
})

describe("Translation Integration (Errors)", () => {
  test("handles empty contents gracefully", async () => {
    await mock.module("~/services/copilot/create-chat-completions", () => ({
      createChatCompletions: () => {
        throw new Error("Should not be called with empty contents")
      },
    }))
    const res = await makeRequest(GEMINI_PRO_URL, { contents: [] })
    expect(res.status).toBe(500)
  })

  test("handles translation errors gracefully", async () => {
    await mock.module("~/services/copilot/create-chat-completions", () => ({
      createChatCompletions: () => {
        throw new Error("Copilot API error")
      },
    }))
    const res = await makeRequest(GEMINI_PRO_URL, {
      contents: [{ role: "user", parts: [{ text: "This should fail" }] }],
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  test("handles malformed tool calls in content processing", async () => {
    await mock.module("~/services/copilot/create-chat-completions", () => ({
      createChatCompletions: () => ({
        id: "x",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    }))
    const res = await makeRequest(GEMINI_PRO_URL, {
      contents: [
        { role: "user", parts: [{ text: "Process this" }] },
        { role: "model", parts: [{ functionCall: { name: "", args: {} } }] },
      ],
    })
    expect(res.status).toBe(200)
  })
})
