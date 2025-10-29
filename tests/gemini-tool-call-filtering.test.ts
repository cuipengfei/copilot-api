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
 * Test Scenario Group: D1 defect verification (early empty tool_call chunk handling)
 *
 * UPDATED after stub emission fix:
 * - Empty scaffold chunks → returns null (skipped)
 * - Name-only chunks → returns null (accumulator not ready)
 * - Complete name+args → accumulator outputs functionCall
 *
 * This verifies the fix prevents duplicate calls by NOT emitting stubs prematurely.
 */

test("D1: empty tool call scaffold chunk is filtered (returns null)", () => {
  const accumulator = new ToolCallAccumulator()
  const firstChunk: ChatCompletionChunk = {
    id: "chatcmpl-123",
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
              id: "call_abc123",
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
  const result = translateOpenAIChunkToGemini(firstChunk, accumulator)
  // CRITICAL: Empty scaffold should be filtered (returns null)
  expect(result).toBeNull()
})

test("D1: name-only chunk returns null (waits for args)", () => {
  const accumulator = new ToolCallAccumulator()

  // Chunk 1: scaffold
  const firstChunk: ChatCompletionChunk = {
    id: "chatcmpl-123",
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
              id: "call_abc123",
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
  translateOpenAIChunkToGemini(firstChunk, accumulator)

  // Chunk 2: name-only (NO stub emission after fix)
  const secondChunk: ChatCompletionChunk = {
    id: "chatcmpl-123",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { name: "list_pages" } }] },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const result = translateOpenAIChunkToGemini(secondChunk, accumulator)

  // CRITICAL: Name-only chunk should return null (not emit stub)
  expect(result).toBeNull()
})

test("D1: name+args together outputs functionCall immediately", () => {
  const accumulator = new ToolCallAccumulator()

  // Scaffold
  const chunk1: ChatCompletionChunk = {
    id: "chatcmpl-123",
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
              id: "call_abc123",
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

  // Name + args in same chunk
  const normalChunk: ChatCompletionChunk = {
    id: "chatcmpl-123",
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
              function: { name: "list_pages", arguments: "{}" },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const result = translateOpenAIChunkToGemini(normalChunk, accumulator)

  expect(result).not.toBeNull()
  if (!result) throw new Error("Expected non-null result")

  const parts = result.candidates[0].content.parts
  expect(parts.length).toBeGreaterThan(0)

  const functionCallParts = parts.filter((p) => isFunctionCallPart(p))
  expect(functionCallParts.length).toBe(1)
  expect(functionCallParts[0].functionCall.name).toBe("list_pages")
})

test("D1: empty tool call with finish_reason emits finish signal", () => {
  const accumulator = new ToolCallAccumulator()
  const chunkWithFinish: ChatCompletionChunk = {
    id: "chatcmpl-123",
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
              id: "call_abc123",
              type: "function",
              function: { name: "", arguments: "" },
            },
          ],
        },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
  }
  const result = translateOpenAIChunkToGemini(chunkWithFinish, accumulator)

  // Should emit finish signal even with empty tool calls
  expect(result).not.toBeNull()
  if (!result) throw new Error("Expected non-null result")
  expect(result.candidates[0].finishReason).toBeDefined()
})

test("D1: realistic streaming scenario - accumulator assembles complete call", () => {
  const accumulator = new ToolCallAccumulator()

  const chunk1: ChatCompletionChunk = {
    id: "chatcmpl-stream",
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
              id: "call_stream_123",
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

  const chunk2: ChatCompletionChunk = {
    id: "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { name: "list_pages" } }] },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const result2 = translateOpenAIChunkToGemini(chunk2, accumulator)
  // Name-only: should return null
  expect(result2).toBeNull()

  const chunk3: ChatCompletionChunk = {
    id: "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const result3 = translateOpenAIChunkToGemini(chunk3, accumulator)

  // Args complete: accumulator outputs functionCall
  expect(result3).not.toBeNull()
  if (!result3) throw new Error("Expected non-null result3")

  const parts = result3.candidates[0].content.parts
  const functionCallPart = parts.find((p) => isFunctionCallPart(p))

  expect(functionCallPart).toBeDefined()
  expect(functionCallPart?.functionCall.name).toBe("list_pages")
  expect(functionCallPart?.functionCall.args).toEqual({})

  const chunk4: ChatCompletionChunk = {
    id: "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
    ],
  }
  const result4 = translateOpenAIChunkToGemini(chunk4, accumulator)
  expect(result4).not.toBeNull()

  // Collect all functionCalls from entire sequence
  const allFunctionCalls = [result3, result4]
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .flatMap((result) =>
      result.candidates[0].content.parts.filter((p) => isFunctionCallPart(p)),
    )

  // CRITICAL: Should have exactly ONE list_pages call (not duplicate)
  const listPagesCalls = allFunctionCalls.filter(
    (part) => part.functionCall.name === "list_pages",
  )
  expect(listPagesCalls.length).toBe(1)
})

test("D1: multi-tool scenario - each tool outputs once", () => {
  const accumulator = new ToolCallAccumulator()

  const chunk1: ChatCompletionChunk = {
    id: "chatcmpl-multi",
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
              id: "call_tool_1",
              type: "function",
              function: { name: "", arguments: "" },
            },
            {
              index: 1,
              id: "call_tool_2",
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

  const chunk2: ChatCompletionChunk = {
    id: "chatcmpl-multi",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { name: "list_pages" } }] },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const result2 = translateOpenAIChunkToGemini(chunk2, accumulator)
  // Name-only: null
  expect(result2).toBeNull()

  const chunk3: ChatCompletionChunk = {
    id: "chatcmpl-multi",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 1, function: { name: "take_screenshot" } }],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const result3 = translateOpenAIChunkToGemini(chunk3, accumulator)
  // Name-only: null
  expect(result3).toBeNull()

  const chunk4: ChatCompletionChunk = {
    id: "chatcmpl-multi",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const result4 = translateOpenAIChunkToGemini(chunk4, accumulator)

  const chunk5: ChatCompletionChunk = {
    id: "chatcmpl-multi",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 1, function: { arguments: '{"fullPage":true}' } },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const result5 = translateOpenAIChunkToGemini(chunk5, accumulator)

  const chunk6: ChatCompletionChunk = {
    id: "chatcmpl-multi",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
    ],
  }
  const result6 = translateOpenAIChunkToGemini(chunk6, accumulator)

  const allResults = [result2, result3, result4, result5, result6].filter(
    (r): r is NonNullable<typeof r> => r !== null,
  )
  const allFunctionCalls = allResults.flatMap((result) =>
    result.candidates[0].content.parts
      .filter((part): part is GeminiFunctionCallPart =>
        isFunctionCallPart(part),
      )
      .map((p) => p.functionCall),
  )

  // CRITICAL: Should have exactly TWO calls (one per tool)
  expect(allFunctionCalls.length).toBe(2)

  const tool1 = allFunctionCalls.find((fc) => fc.name === "list_pages")
  const tool2 = allFunctionCalls.find((fc) => fc.name === "take_screenshot")
  expect(tool1).toBeDefined()
  expect(tool2).toBeDefined()

  expect(tool1?.args).toEqual({})
  expect(tool2?.args).toEqual({ fullPage: true })
})
