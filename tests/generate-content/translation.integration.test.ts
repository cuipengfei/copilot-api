import { afterEach, describe, expect, test, mock } from "bun:test"

import type { TranslationCase } from "./test-types"

import {
  makeRequest,
  setupPayloadCapture,
  expectToolCleanup,
  GEMINI_PRO_URL,
  buildTranslationCase,
} from "./_test-utils/integration"

afterEach(() => {
  mock.restore()
})

// File split: Keep only Role Normalization + Tool Call Lifecycle to satisfy max-lines-per-function
// Other scenarios moved to translation.integration.extra.test.ts

describe("Translation Integration (Core)", () => {
  describe("Role Normalization", () => {
    const roleCases: Array<TranslationCase> = [
      buildTranslationCase({
        name: "merges same-role consecutive messages",
        contents: [
          { role: "user", parts: [{ text: "Hello." }] },
          { role: "user", parts: [{ text: "How are you?" }] },
        ],
        expectMessages: 1,
        expectRoles: ["user"],
      }),
      buildTranslationCase({
        name: "handles system instruction in contents",
        systemInstruction: { parts: [{ text: "You are a helpful assistant" }] },
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        expectMessages: 2,
        expectRoles: ["system", "user"],
      }),
    ]

    test.each(roleCases)(
      "$name",
      async (testCase) => {
        const capturedPayload = await setupPayloadCapture()
        const res = await makeRequest(GEMINI_PRO_URL, {
          systemInstruction: testCase.input.systemInstruction,
          contents: testCase.input.contents,
        })
        expect(res.status).toBe(200)
        if (testCase.expect.messageCount) {
          expect(capturedPayload.messages?.length).toBeGreaterThanOrEqual(
            testCase.expect.messageCount,
          )
        }
        if (testCase.expect.roles) {
          const actualRoles = (capturedPayload.messages ?? []).map(
            (m) => m.role,
          )
          for (const expectedRole of testCase.expect.roles) {
            expect(actualRoles).toContain(expectedRole)
          }
        }
      },
      10000,
    )
  })

  describe("Tool Call Lifecycle", () => {
    test("retains assistant pending tool call without response (updated cleanup policy)", async () => {
      const capturedPayload = await setupPayloadCapture()
      const res = await makeRequest(GEMINI_PRO_URL, {
        contents: [
          { role: "user", parts: [{ text: "Search for cats." }] },
          {
            role: "model",
            parts: [
              { functionCall: { name: "search", args: { query: "cats" } } },
            ],
          },
          { role: "user", parts: [{ text: "Show me results." }] },
        ],
      })
      expect(res.status).toBe(200)
      const assistantMessages =
        capturedPayload.messages?.filter((m) => m.role === "assistant") ?? []
      expect(assistantMessages.length).toBe(1)
      expect(assistantMessages[0].tool_calls?.[0].function.name).toBe("search")
      const userMessages =
        capturedPayload.messages?.filter((m) => m.role === "user") ?? []
      expect(userMessages.length).toBeGreaterThan(0)
    })

    test("handles complex tool call workflow", async () => {
      const capturedPayload = await setupPayloadCapture()
      const res = await makeRequest(GEMINI_PRO_URL, {
        contents: [
          { role: "user", parts: [{ text: "Read a file" }] },
          {
            role: "model",
            parts: [
              {
                functionCall: { name: "readFile", args: { path: "test.txt" } },
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "readFile",
                  response: { content: "Hello World" },
                },
              },
            ],
          },
        ],
      })
      expect(res.status).toBe(200)
      expect(
        capturedPayload.messages?.some(
          (m) => m.role === "assistant" && m.tool_calls,
        ),
      ).toBe(true)
      expect(capturedPayload.messages?.some((m) => m.role === "tool")).toBe(
        true,
      )
    })

    test("synthesizes tools from function calls when tools not provided", async () => {
      const capturedPayload = await setupPayloadCapture()
      const res = await makeRequest(GEMINI_PRO_URL, {
        contents: [
          { role: "user", parts: [{ text: "Do a web search" }] },
          {
            role: "model",
            parts: [
              { functionCall: { name: "search", args: { query: "cats" } } },
            ],
          },
        ],
      })
      expect(res.status).toBe(200)
      expect(capturedPayload.tools).toBeDefined()
      const toolNames = capturedPayload.tools?.map((t) => t.function.name) ?? []
      expect(toolNames.includes("search")).toBe(true)
      expectToolCleanup(capturedPayload, {
        noDuplicates: true,
        noEmptyFunctions: true,
      })
    })

    test("handles urlContext tool filtering in request", async () => {
      const capturedPayload = await setupPayloadCapture()
      const res = await makeRequest(GEMINI_PRO_URL, {
        tools: [
          { urlContext: {} },
          {
            functionDeclarations: [
              { name: "readFile", parameters: { type: "object" } },
            ],
          },
        ],
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      })
      expect(res.status).toBe(200)
      expect(capturedPayload.tools).toBeDefined()
      const toolNames = new Set(
        capturedPayload.tools?.map((t) => t.function.name) ?? [],
      )
      expect(toolNames.has("readFile")).toBe(true)
      expect(toolNames.has("urlContext")).toBe(false)
      expectToolCleanup(capturedPayload, { noEmptyFunctions: true })
    })
  })
})
