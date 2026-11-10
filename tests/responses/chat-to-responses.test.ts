import { describe, expect, it } from "bun:test"

import type { ChatCompletionResponse } from "~/lib/types/chat-completions"

import { translateChatCompletionToResponsesResult } from "~/routes/responses/responses-from-chat"

const baseChatCompletion = (
  overrides: Partial<ChatCompletionResponse> = {},
): ChatCompletionResponse => ({
  id: "chatcmpl_123",
  object: "chat.completion",
  created: 1_714_000_000,
  model: "gpt-4.1",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Hello from chat.",
      },
      logprobs: null,
      finish_reason: "stop",
    },
  ],
  ...overrides,
})

describe("translateChatCompletionToResponsesResult", () => {
  it("maps assistant text content into Responses output_text content", () => {
    const result =
      translateChatCompletionToResponsesResult(baseChatCompletion())

    expect(result).toMatchObject({
      id: "resp_chatcmpl_123",
      object: "response",
      created_at: 1_714_000_000,
      model: "gpt-4.1",
      output_text: "Hello from chat.",
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: null,
      tools: [],
      top_p: null,
    })

    expect(result.output).toEqual([
      {
        id: "msg_chatcmpl_123_0",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Hello from chat.",
            annotations: [],
          },
        ],
      },
    ])
  })

  it("maps assistant tool_calls into Responses function_call output items", () => {
    const result = translateChatCompletionToResponsesResult(
      baseChatCompletion({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: {
                    name: "lookup_weather",
                    arguments: '{"city":"Hangzhou"}',
                  },
                },
              ],
            },
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
      }),
    )

    expect(result.status).toBe("completed")
    expect(result.incomplete_details).toBeNull()
    expect(result.output_text).toBe("")
    expect(result.output).toEqual([
      {
        id: "fc_call_abc",
        type: "function_call",
        call_id: "call_abc",
        name: "lookup_weather",
        arguments: '{"city":"Hangzhou"}',
        status: "completed",
      },
    ])
  })

  it("maps usage fields into Responses token usage", () => {
    const result = translateChatCompletionToResponsesResult(
      baseChatCompletion({
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          prompt_tokens_details: {
            cached_tokens: 3,
          },
        },
      }),
    )

    expect(result.usage).toEqual({
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      input_tokens_details: {
        cached_tokens: 3,
      },
    })
  })

  it("preserves Copilot usage for downstream cost tracking", () => {
    const result = translateChatCompletionToResponsesResult(
      baseChatCompletion({
        copilot_usage: {
          total_nano_aiu: 1_500_000,
        },
      }),
    )

    expect(result.copilot_usage).toEqual({
      total_nano_aiu: 1_500_000,
    })
  })

  it.each([
    { signal: "finish_reason:error", finishReason: "error", error: undefined },
    {
      signal: "top-level error despite stop",
      finishReason: "stop",
      error: {
        code: "generation_failed",
        message: "The upstream generator could not finish this completion.",
        type: "server_error",
      },
    },
  ])("returns failed with partial output and usage for $signal", (failure) => {
    const response = Object.assign(
      baseChatCompletion({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Partial answer",
              tool_calls: [
                {
                  id: "call_partial",
                  type: "function",
                  function: { name: "lookup_weather", arguments: '{"city":' },
                },
              ],
            },
            logprobs: null,
            finish_reason: failure.finishReason,
          },
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 2,
          total_tokens: 13,
          prompt_tokens_details: { cached_tokens: 3 },
        },
        copilot_usage: { total_nano_aiu: 1_500_000 },
      }),
      { error: failure.error },
    )

    const result = translateChatCompletionToResponsesResult(response)

    expect(result.status).toBe("failed")
    expect(result.incomplete_details).toBeNull()
    expect(typeof result.error?.message).toBe("string")
    expect(result.error?.message.length).toBeGreaterThan(0)
    if (failure.error) {
      expect(result.error).toMatchObject({
        code: failure.error.code,
        message: failure.error.message,
      })
    }
    expect(result.output_text).toBe("Partial answer")
    expect(result.output).toMatchObject([
      {
        type: "message",
        status: "incomplete",
        content: [
          { type: "output_text", text: "Partial answer", annotations: [] },
        ],
      },
      {
        type: "function_call",
        call_id: "call_partial",
        name: "lookup_weather",
        arguments: '{"city":',
        status: "incomplete",
      },
    ])
    expect(result.usage).toEqual({
      input_tokens: 11,
      output_tokens: 2,
      total_tokens: 13,
      input_tokens_details: { cached_tokens: 3 },
    })
    expect(result.copilot_usage).toEqual({ total_nano_aiu: 1_500_000 })
  })

  it("conservatively maps length finish_reason to incomplete max_output_tokens", () => {
    const result = translateChatCompletionToResponsesResult(
      baseChatCompletion({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Partial answer",
            },
            logprobs: null,
            finish_reason: "length",
          },
        ],
      }),
    )

    expect(result.status).toBe("incomplete")
    expect(result.incomplete_details).toEqual({ reason: "max_output_tokens" })
    expect(result.output[0]).toMatchObject({ status: "incomplete" })
  })

  it("conservatively maps content_filter finish_reason to incomplete content_filter", () => {
    const result = translateChatCompletionToResponsesResult(
      baseChatCompletion({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Filtered answer",
            },
            logprobs: null,
            finish_reason: "content_filter",
          },
        ],
      }),
    )

    expect(result.status).toBe("incomplete")
    expect(result.incomplete_details).toEqual({ reason: "content_filter" })
    expect(result.error).toBeNull()
  })
})
