import { describe, it, expect } from "bun:test"

import type { GeminiContent, GeminiPart } from "~/routes/generate-content/types"
import type {
  ChatCompletionChunk,
  Message,
} from "~/services/copilot/create-chat-completions"

import {
  translateGeminiContentsToOpenAI,
  translateOpenAIChunkToGemini,
} from "~/routes/generate-content/translation"

// Type guards for messages
function isAssistantMessage(m: Message): m is Message & { role: "assistant" } {
  return m.role === "assistant"
}

function isToolMessage(m: Message): m is Message & { role: "tool" } {
  return m.role === "tool"
}

describe("Gemini to OpenAI Translation - Multiple Tool Calls", () => {
  it("should handle multiple tool calls to the same function name correctly", () => {
    const contents: Array<GeminiContent> = [
      {
        role: "user",
        parts: [{ text: "Search for A and B" }],
      },
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "search", args: { query: "A" } },
          },
          {
            functionCall: { name: "search", args: { query: "B" } },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "search",
              response: { results: "Results for A" },
            },
          },
          {
            functionResponse: {
              name: "search",
              response: { results: "Results for B" },
            },
          },
        ],
      },
    ]

    const messages: Array<Message> = translateGeminiContentsToOpenAI(contents)

    const assistantMessage = messages.find((m) => isAssistantMessage(m))
    expect(assistantMessage?.tool_calls?.length).toBe(2)
    const toolCallA = assistantMessage?.tool_calls?.[0]
    const toolCallB = assistantMessage?.tool_calls?.[1]

    const toolMessages = messages.filter((m) => isToolMessage(m))
    expect(toolMessages.length).toBe(2)

    const toolResponseA = toolMessages.find(
      (m) => m.tool_call_id === toolCallA?.id,
    )
    const toolResponseB = toolMessages.find(
      (m) => m.tool_call_id === toolCallB?.id,
    )

    expect(toolResponseA?.content).toBe(
      JSON.stringify({ results: "Results for A" }),
    )
    expect(toolResponseB?.content).toBe(
      JSON.stringify({ results: "Results for B" }),
    )
  })
})

describe("Gemini to OpenAI Translation - Message Merging", () => {
  it("should prevent merging of consecutive tool messages", () => {
    const contents: Array<GeminiContent> = [
      {
        role: "model",
        parts: [{ functionCall: { name: "tool1", args: {} } }],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "tool1", response: { success: true } } },
        ],
      },
      {
        role: "model",
        parts: [{ functionCall: { name: "tool2", args: {} } }],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "tool2", response: { success: true } } },
        ],
      },
    ]

    const messages = translateGeminiContentsToOpenAI(contents)
    const toolMessages = messages.filter((m) => isToolMessage(m))

    expect(toolMessages.length).toBe(2)
  })
})

describe("Gemini to OpenAI Translation - ID Mapping", () => {
  it("should handle multiple same-name functions with correct ID mapping", () => {
    const contents: Array<GeminiContent> = [
      {
        role: "model",
        parts: [
          { functionCall: { name: "list_files", args: { path: "/home" } } },
          { functionCall: { name: "list_files", args: { path: "/var" } } },
          { functionCall: { name: "list_files", args: { path: "/tmp" } } },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "list_files",
              response: { files: ["home_file1", "home_file2"] },
            },
          },
          {
            functionResponse: {
              name: "list_files",
              response: { files: ["var_file1", "var_file2"] },
            },
          },
          {
            functionResponse: {
              name: "list_files",
              response: { files: ["tmp_file1"] },
            },
          },
        ],
      },
    ]

    const messages = translateGeminiContentsToOpenAI(contents)

    const assistantMessage = messages.find((m) => isAssistantMessage(m))
    const toolMessages = messages.filter((m) => isToolMessage(m))

    expect(assistantMessage?.tool_calls?.length).toBe(3)
    expect(toolMessages.length).toBe(3)

    const toolCallIds = assistantMessage?.tool_calls?.map((tc) => tc.id) || []
    const toolResponseIds = toolMessages.map((tm) => tm.tool_call_id)

    expect(new Set(toolCallIds).size).toBe(3)
    expect(new Set(toolResponseIds).size).toBe(3)

    for (const toolCall of assistantMessage?.tool_calls || []) {
      const matchingResponse = toolMessages.find(
        (tm) => tm.tool_call_id === toolCall.id,
      )
      expect(matchingResponse).toBeDefined()
    }
  })
})

describe("Gemini to OpenAI Translation - Nested Arrays", () => {
  it("should handle nested function response arrays correctly", () => {
    const contents: Array<
      | GeminiContent
      | Array<{
          functionResponse: { name: string; response: unknown }
        }>
    > = [
      {
        role: "model",
        parts: [
          { functionCall: { name: "tool_a", args: { query: "A" } } },
          { functionCall: { name: "tool_b", args: { query: "B" } } },
        ],
      },
      [
        {
          functionResponse: {
            name: "tool_a",
            response: { result: "Response A" },
          },
        },
        {
          functionResponse: {
            name: "tool_b",
            response: { result: "Response B" },
          },
        },
      ],
    ]

    const messages = translateGeminiContentsToOpenAI(contents)
    const toolMessages = messages.filter((m) => isToolMessage(m))

    expect(toolMessages.length).toBe(2)

    const responseA = toolMessages.find(
      (m) => m.content === JSON.stringify({ result: "Response A" }),
    )
    const responseB = toolMessages.find(
      (m) => m.content === JSON.stringify({ result: "Response B" }),
    )

    expect(responseA).toBeDefined()
    expect(responseB).toBeDefined()
    expect(responseA?.tool_call_id).toBeDefined()
    expect(responseB?.tool_call_id).toBeDefined()
    expect(responseA?.tool_call_id).not.toBe(responseB?.tool_call_id)
  })
})

describe("Gemini to OpenAI Translation - Deduplication", () => {
  it("should deduplicate tool responses for the same tool_call_id", () => {
    const contents: Array<GeminiContent> = [
      {
        role: "model",
        parts: [{ functionCall: { name: "search", args: { query: "C" } } }],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "search",
              response: { results: "Results for C" },
            },
          },
          {
            functionResponse: {
              name: "search",
              response: { results: "Results for C" },
            },
          },
        ],
      },
    ]

    const messages = translateGeminiContentsToOpenAI(contents)
    const toolMessages = messages.filter((m) => isToolMessage(m))

    expect(toolMessages.length).toBe(1)
    expect(toolMessages[0].content).toBe(
      JSON.stringify({ results: "Results for C" }),
    )
  })
})

describe("OpenAI to Gemini Stream Translation - Tool Call Fixes", () => {
  it("should skip chunks with only empty or whitespace tool call names", () => {
    const chunk: ChatCompletionChunk = {
      id: "chunk1",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "gpt-4",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call1",
                type: "function",
                function: { name: " ", arguments: "" },
              },
            ],
          },
          logprobs: null,
          finish_reason: null,
        },
      ],
    }

    const result = translateOpenAIChunkToGemini(chunk)
    expect(result).toBeNull()
  })

  it("should not skip a chunk if it has a finish reason, even with empty tool calls", () => {
    const chunk: ChatCompletionChunk = {
      id: "chunk1",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "gpt-4",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call1",
                type: "function",
                function: { name: "", arguments: "" },
              },
            ],
          },
          logprobs: null,
          finish_reason: "tool_calls",
        },
      ],
    }

    const result = translateOpenAIChunkToGemini(chunk)
    expect(result).not.toBeNull()
    expect(result?.candidates[0].finishReason).toBe("STOP")
    expect(result?.candidates[0].content.parts).toEqual([{ text: "" }])
  })

  it("should process a valid tool call chunk correctly", () => {
    const chunk: ChatCompletionChunk = {
      id: "chunk1",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "gpt-4",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call1",
                type: "function",
                function: { name: "valid_tool", arguments: "{}" },
              },
            ],
          },
          logprobs: null,
          finish_reason: null,
        },
      ],
    }

    const result = translateOpenAIChunkToGemini(chunk)
    expect(result).not.toBeNull()
    const part = result?.candidates[0].content.parts[0] as GeminiPart & {
      functionCall: { name: string; args: object }
    }
    expect(part.functionCall).toEqual({ name: "valid_tool", args: {} })
  })
})
