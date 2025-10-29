import { expect, test } from "bun:test"

import type { GeminiRequest } from "~/routes/generate-content/types"

import { translateGeminiToOpenAI } from "~/routes/generate-content/translation"

/**
 * Test Scenario Group: D2 defect (pending assistant tool_call message was removed).
 *
 * Defect location before fix: translation.ts:231-280 / 271-330
 * Problem code (prior): if (message.tool_calls && !hasCorrespondingToolResponses(...)) return true
 * Impact: Assistant tool call initiation message was deleted before any tool response arrived, losing context.
 * Reproduction strategy:
 * 1. Build Gemini contents containing a functionCall part.
 * 2. Omit the corresponding functionResponse part.
 * 3. Invoke translateGeminiToOpenAI.
 * 4. Verify assistant tool call message is retained (length and tool_calls array present).
 */

test("D2: retains pending assistant tool call message without response", () => {
  const geminiRequest: GeminiRequest = {
    contents: [
      { role: "user", parts: [{ text: "List current browser pages" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "list_pages", args: {} } }],
      },
      // Missing functionResponse on purpose.
    ],
  }

  const result = translateGeminiToOpenAI(geminiRequest, "gemini-pro", false)
  const assistantMessages = result.messages.filter(
    (msg) => msg.role === "assistant",
  )
  expect(assistantMessages.length).toBe(1)
  expect(assistantMessages[0].tool_calls).toBeDefined()
  expect(assistantMessages[0].tool_calls?.[0].function.name).toBe("list_pages")
})

test("D2: retains tool call and tool response for complete flow", () => {
  const geminiRequest: GeminiRequest = {
    contents: [
      { role: "user", parts: [{ text: "List current browser pages" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "list_pages", args: {} } }],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "list_pages",
              response: { pages: ["page1", "page2"] },
            },
          },
        ],
      },
    ],
  }

  const result = translateGeminiToOpenAI(geminiRequest, "gemini-pro", false)
  expect(result.messages.length).toBe(3)
  const assistantMsg = result.messages[1]
  expect(assistantMsg.role).toBe("assistant")
  expect(assistantMsg.tool_calls).toBeDefined()
  const toolMsg = result.messages[2]
  expect(toolMsg.role).toBe("tool")
  expect(toolMsg.tool_call_id).toBeDefined()
})

test("D2: multiple tool calls retains both assistant messages when second lacks response", () => {
  const geminiRequest: GeminiRequest = {
    contents: [
      { role: "user", parts: [{ text: "List pages and navigate" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "list_pages", args: {} } }],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "list_pages", response: { pages: [] } } },
        ],
      },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              name: "navigate_page",
              args: { url: "https://example.com" },
            },
          },
        ],
      },
      // No functionResponse for navigate_page.
    ],
  }

  const result = translateGeminiToOpenAI(geminiRequest, "gemini-pro", false)
  const assistantMessages = result.messages.filter(
    (msg) => msg.role === "assistant",
  )
  expect(assistantMessages.length).toBe(2)
  if (assistantMessages.length >= 2) {
    expect(assistantMessages[0].tool_calls?.[0].function.name).toBe(
      "list_pages",
    )
    expect(assistantMessages[1].tool_calls?.[0].function.name).toBe(
      "navigate_page",
    )
  }
})

test("D2: nested array format functionResponse is processed correctly", () => {
  const geminiRequest: GeminiRequest = {
    contents: [
      { role: "user", parts: [{ text: "List pages" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "list_pages", args: {} } }],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "list_pages",
              response: { pages: ["page1"] },
            },
          },
        ],
      },
    ],
  }
  const result = translateGeminiToOpenAI(geminiRequest, "gemini-pro", false)
  expect(result.messages.length).toBe(3)
  const toolMsg = result.messages[2]
  expect(toolMsg.role).toBe("tool")
  expect(JSON.parse(toolMsg.content as string)).toEqual({ pages: ["page1"] })
})

test("D2: cleanupMessages does not remove pending assistant tool call", () => {
  const geminiRequest: GeminiRequest = {
    contents: [
      { role: "user", parts: [{ text: "Execute tool call" }] },
      {
        role: "model",
        parts: [
          { text: "Let me list the pages first" },
          { functionCall: { name: "list_pages", args: {} } },
        ],
      },
      // No functionResponse
    ],
  }

  const result = translateGeminiToOpenAI(geminiRequest, "gemini-pro", false)
  const assistantMsg = result.messages.find((msg) => msg.role === "assistant")
  expect(assistantMsg).toBeDefined()
  expect(assistantMsg?.content).toBe("Let me list the pages first")
  expect(assistantMsg?.tool_calls).toBeDefined()
  expect(assistantMsg?.tool_calls?.length).toBe(1)
})
