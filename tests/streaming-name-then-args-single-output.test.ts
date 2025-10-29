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
 * Test real-world streaming scenario: name-only chunk → args-only chunk
 * CRITICAL: Verifies stub emission deletion fix prevents duplicate functionCall outputs
 *
 * Bug scenario (before fix):
 * - Chunk 2 (name-only) → outputs { functionCall: { name: "read_file", args: {} } }
 * - Chunk 3 (args-only) → accumulator outputs { functionCall: { name: "read_file", args: { absolute_path: "..." } } }
 * - Result: Gemini CLI receives TWO calls (first fails with missing params)
 *
 * Expected behavior (after fix):
 * - Chunk 2 (name-only) → returns null (no output yet)
 * - Chunk 3 (args-only) → accumulator outputs complete functionCall ONCE
 * - Result: Single complete call with all parameters
 */

test("Real streaming: name-only → args-only produces single complete output", () => {
  const accumulator = new ToolCallAccumulator()

  // Chunk 1: Empty scaffold (index + id only)
  const chunk1: ChatCompletionChunk = {
    id: "chatcmpl-real-stream",
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
              id: "call_read_file_123",
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
  expect(result1).toBeNull() // Should be filtered

  // Chunk 2: Name-only (NO args yet)
  const chunk2: ChatCompletionChunk = {
    id: "chatcmpl-real-stream",
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
              function: { name: "read_file" },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const result2 = translateOpenAIChunkToGemini(chunk2, accumulator)

  // CRITICAL: After fix, name-only chunk should NOT output stub
  expect(result2).toBeNull()

  // Chunk 3: Args-only (complete parameters)
  const chunk3: ChatCompletionChunk = {
    id: "chatcmpl-real-stream",
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
                arguments: String.raw`{"absolute_path":"D:\\code\\copilot-api\\package.json"}`,
              },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
  const result3 = translateOpenAIChunkToGemini(chunk3, accumulator)

  // Accumulator should now output complete functionCall
  expect(result3).not.toBeNull()
  if (!result3) throw new Error("Expected result3 to be non-null")

  const parts3 = result3.candidates[0].content.parts
  const functionCallParts = parts3.filter((p) => isFunctionCallPart(p))

  // CRITICAL: Should have exactly ONE complete functionCall (not two)
  expect(functionCallParts.length).toBe(1)
  expect(functionCallParts[0].functionCall.name).toBe("read_file")
  expect(functionCallParts[0].functionCall.args).toEqual({
    absolute_path: String.raw`D:\code\copilot-api\package.json`,
  })

  // Chunk 4: Finish reason
  const chunk4: ChatCompletionChunk = {
    id: "chatcmpl-real-stream",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "tool_calls",
        logprobs: null,
      },
    ],
  }
  const result4 = translateOpenAIChunkToGemini(chunk4, accumulator)
  expect(result4).not.toBeNull()
})

test("Real streaming: verifies no duplicate calls in entire sequence", () => {
  const accumulator = new ToolCallAccumulator()

  const chunks: Array<ChatCompletionChunk> = [
    // Chunk 1: scaffold
    {
      id: "chatcmpl-dup-check",
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
                id: "call_list_pages",
                type: "function",
                function: { name: "", arguments: "" },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    // Chunk 2: name-only
    {
      id: "chatcmpl-dup-check",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "gpt-5-mini",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { name: "list_pages" } }],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    // Chunk 3: args-only
    {
      id: "chatcmpl-dup-check",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "gpt-5-mini",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: "{}" } }],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    // Chunk 4: finish
    {
      id: "chatcmpl-dup-check",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "gpt-5-mini",
      choices: [
        { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
      ],
    },
  ]

  const allResults = chunks.map((chunk) =>
    translateOpenAIChunkToGemini(chunk, accumulator),
  )

  // Collect all functionCall parts from all results
  const allFunctionCalls = allResults
    .filter((result): result is NonNullable<typeof result> => result !== null)
    .flatMap((result) =>
      result.candidates[0].content.parts
        .filter((p) => isFunctionCallPart(p))
        .map((part) => part.functionCall),
    )

  // CRITICAL: Should have exactly ONE list_pages call (not multiple)
  const listPagesCalls = allFunctionCalls.filter(
    (fc) => fc.name === "list_pages",
  )
  expect(listPagesCalls.length).toBe(1)
  expect(listPagesCalls[0].args).toEqual({})
})
