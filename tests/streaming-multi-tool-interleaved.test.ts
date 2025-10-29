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
 * Test complex interleaved multi-tool streaming scenario
 * CRITICAL: Verifies accumulator correctly handles interleaved chunks
 *
 * Real-world pattern from Copilot API:
 * - tool_0 scaffold
 * - tool_1 scaffold
 * - tool_0 name
 * - tool_1 name
 * - tool_0 args (partial)
 * - tool_1 args (partial)
 * - tool_0 args (rest)
 * - tool_1 args (rest)
 *
 * Expected: Each tool produces exactly ONE complete functionCall
 */

test("Multi-tool interleaved: complex streaming produces correct outputs", () => {
  const accumulator = new ToolCallAccumulator()

  const chunks: Array<ChatCompletionChunk> = [
    // Chunk 1: tool_0 scaffold
    {
      id: "chatcmpl-interleaved",
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
                id: "call_tool_0",
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
    // Chunk 2: tool_1 scaffold
    {
      id: "chatcmpl-interleaved",
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
                id: "call_tool_1",
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
    // Chunk 3: tool_0 name
    {
      id: "chatcmpl-interleaved",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "gpt-5-mini",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { name: "read_file" } }],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    // Chunk 4: tool_1 name
    {
      id: "chatcmpl-interleaved",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "gpt-5-mini",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 1, function: { name: "write_file" } }],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    // Chunk 5: tool_0 args (partial)
    {
      id: "chatcmpl-interleaved",
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
                function: { arguments: '{"absolute_path":"D:\\\\code\\\\' },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    // Chunk 6: tool_1 args (partial)
    {
      id: "chatcmpl-interleaved",
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
                function: { arguments: '{"absolute_path":"D:\\\\output\\\\' },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    // Chunk 7: tool_0 args (rest)
    {
      id: "chatcmpl-interleaved",
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
                function: { arguments: String.raw`copilot-api\\README.md"}` },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    // Chunk 8: tool_1 args (rest)
    {
      id: "chatcmpl-interleaved",
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
                function: { arguments: 'result.txt","content":"Hello"}' },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    // Chunk 9: Finish
    {
      id: "chatcmpl-interleaved",
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

  // Collect all functionCall parts
  const allFunctionCalls = allResults
    .filter((result): result is NonNullable<typeof result> => result !== null)
    .flatMap((result) =>
      result.candidates[0].content.parts
        .filter((p) => isFunctionCallPart(p))
        .map((part) => part.functionCall),
    )

  // CRITICAL: Should have exactly TWO calls (one per tool)
  expect(allFunctionCalls.length).toBe(2)

  // Verify read_file call
  const readFileCalls = allFunctionCalls.filter((fc) => fc.name === "read_file")
  expect(readFileCalls.length).toBe(1)
  expect(readFileCalls[0].args).toEqual({
    absolute_path: String.raw`D:\code\copilot-api\README.md`,
  })

  // Verify write_file call
  const writeFileCalls = allFunctionCalls.filter(
    (fc) => fc.name === "write_file",
  )
  expect(writeFileCalls.length).toBe(1)
  expect(writeFileCalls[0].args).toEqual({
    absolute_path: String.raw`D:\output\result.txt`,
    content: "Hello",
  })
})

test("Multi-tool interleaved: three tools with mixed chunking patterns", () => {
  const accumulator = new ToolCallAccumulator()

  const chunks: Array<ChatCompletionChunk> = [
    // All scaffolds at once
    {
      id: "chatcmpl-three-tools",
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
                id: "call_0",
                type: "function",
                function: { name: "", arguments: "" },
              },
              {
                index: 1,
                id: "call_1",
                type: "function",
                function: { name: "", arguments: "" },
              },
              {
                index: 2,
                id: "call_2",
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
    // tool_0: name-only
    {
      id: "chatcmpl-three-tools",
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
    // tool_1: name + args in same chunk
    {
      id: "chatcmpl-three-tools",
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
    },
    // tool_2: name-only
    {
      id: "chatcmpl-three-tools",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "gpt-5-mini",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 2, function: { name: "take_screenshot" } }],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    // tool_0: args-only
    {
      id: "chatcmpl-three-tools",
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
    // tool_2: args-only
    {
      id: "chatcmpl-three-tools",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "gpt-5-mini",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 2,
                function: { arguments: '{"fullPage":true}' },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    // Finish
    {
      id: "chatcmpl-three-tools",
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

  const allFunctionCalls = allResults
    .filter((result): result is NonNullable<typeof result> => result !== null)
    .flatMap((result) =>
      result.candidates[0].content.parts
        .filter((p) => isFunctionCallPart(p))
        .map((part) => part.functionCall),
    )

  // CRITICAL: Should have exactly THREE calls
  expect(allFunctionCalls.length).toBe(3)

  // Verify all three tools present with correct args
  const listPagesCalls = allFunctionCalls.filter(
    (fc) => fc.name === "list_pages",
  )
  expect(listPagesCalls.length).toBe(1)
  expect(listPagesCalls[0].args).toEqual({})

  const navigateCalls = allFunctionCalls.filter(
    (fc) => fc.name === "navigate_page",
  )
  expect(navigateCalls.length).toBe(1)
  expect(navigateCalls[0].args).toEqual({ url: "https://example.com" })

  const screenshotCalls = allFunctionCalls.filter(
    (fc) => fc.name === "take_screenshot",
  )
  expect(screenshotCalls.length).toBe(1)
  expect(screenshotCalls[0].args).toEqual({ fullPage: true })
})
