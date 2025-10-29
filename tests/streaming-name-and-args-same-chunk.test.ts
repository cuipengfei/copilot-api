import { expect, test } from "bun:test"

import type { GeminiFunctionCallPart } from "~/routes/generate-content/types"
import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import { ToolCallAccumulator } from "~/lib/tool-call-utils"
import { translateOpenAIChunkToGemini } from "~/routes/generate-content/translation"

// Type guard helper for function call parts
function isFunctionCallPart(part: unknown): part is GeminiFunctionCallPart {
  return (
    typeof part === "object"
    && part !== null
    && "functionCall" in part
    && typeof (part as { functionCall: unknown }).functionCall === "object"
  )
}

/**
 * Test scenario: name + args arrive in same chunk
 * CRITICAL: Verifies no duplicate outputs when all data arrives at once
 *
 * This is the "success case" in real traffic where Copilot API sends
 * complete tool call data in a single chunk instead of splitting.
 *
 * Expected behavior:
 * - Single chunk with complete name + args → ONE functionCall output
 * - No stub emission (would cause duplicate)
 */

test("Same-chunk: name+args in single chunk produces single output", () => {
  const accumulator = new ToolCallAccumulator()

  // Chunk 1: Empty scaffold
  const chunk1: ChatCompletionChunk = {
    id: "chatcmpl-same-chunk",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_navigate",
              type: "function",
              function: { name: "", arguments: "" },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const result1 = translateOpenAIChunkToGemini(chunk1, accumulator)
  expect(result1).toBeNull()

  // Chunk 2: Complete name + args in SAME chunk
  const chunk2: ChatCompletionChunk = {
    id: "chatcmpl-same-chunk",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              function: {
                name: "navigate_page",
                arguments: '{"url":"https://example.com"}',
              },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const result2 = translateOpenAIChunkToGemini(chunk2, accumulator)

  // Should output complete functionCall immediately
  expect(result2).not.toBeNull()
  if (!result2) throw new Error("Expected result2 to be non-null")

  const parts2 = result2.candidates[0].content.parts
  const functionCallParts = parts2.filter((p) => isFunctionCallPart(p))

  // CRITICAL: Exactly ONE complete call
  expect(functionCallParts.length).toBe(1)
  expect(functionCallParts[0].functionCall.name).toBe("navigate_page")
  expect(functionCallParts[0].functionCall.args).toEqual({
    url: "https://example.com",
  })

  // Chunk 3: Finish reason
  const chunk3: ChatCompletionChunk = {
    id: "chatcmpl-same-chunk",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
    ],
  }
  const result3 = translateOpenAIChunkToGemini(chunk3, accumulator)
  expect(result3).not.toBeNull()

  // Verify no additional functionCall parts in finish chunk
  if (result3) {
    const finishParts = result3.candidates[0].content.parts.filter((p) =>
      isFunctionCallPart(p),
    )
    expect(finishParts.length).toBe(0) // No duplicate in finish chunk
  }
})

test("Same-chunk: multiple sequential same-chunk calls work correctly", () => {
  const accumulator = new ToolCallAccumulator()

  // First tool call: scaffold
  const chunk1: ChatCompletionChunk = {
    id: "chatcmpl-seq",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_first",
              type: "function",
              function: { name: "", arguments: "" },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  translateOpenAIChunkToGemini(chunk1, accumulator)

  // First tool call: complete in one chunk
  const chunk2: ChatCompletionChunk = {
    id: "chatcmpl-seq",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              function: {
                name: "take_screenshot",
                arguments: '{"fullPage":true}',
              },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const result2 = translateOpenAIChunkToGemini(chunk2, accumulator)

  // Second tool call: scaffold
  const chunk3: ChatCompletionChunk = {
    id: "chatcmpl-seq",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 1,
              id: "call_second",
              type: "function",
              function: { name: "", arguments: "" },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  translateOpenAIChunkToGemini(chunk3, accumulator)

  // Second tool call: complete in one chunk
  const chunk4: ChatCompletionChunk = {
    id: "chatcmpl-seq",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 1,
              function: {
                name: "click",
                arguments: '{"element":"button","ref":"btn-123"}',
              },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const result4 = translateOpenAIChunkToGemini(chunk4, accumulator)

  // Finish
  const chunk5: ChatCompletionChunk = {
    id: "chatcmpl-seq",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
    ],
  }
  const result5 = translateOpenAIChunkToGemini(chunk5, accumulator)

  // Collect all results
  const allResults = [result2, result4, result5].filter(
    (r): r is NonNullable<typeof r> => r !== null,
  )
  const allFunctionCalls = allResults.flatMap((result) =>
    result.candidates[0].content.parts
      .filter((p) => isFunctionCallPart(p))
      .map((part) => part.functionCall),
  )

  // CRITICAL: Should have exactly TWO calls (one per tool)
  expect(allFunctionCalls.length).toBe(2)

  const screenshotCalls = allFunctionCalls.filter(
    (fc) => fc.name === "take_screenshot",
  )
  expect(screenshotCalls.length).toBe(1)
  expect(screenshotCalls[0].args).toEqual({ fullPage: true })

  const clickCalls = allFunctionCalls.filter((fc) => fc.name === "click")
  expect(clickCalls.length).toBe(1)
  expect(clickCalls[0].args).toEqual({ element: "button", ref: "btn-123" })
})
