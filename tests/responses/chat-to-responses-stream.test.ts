import { describe, expect, it } from "bun:test"

import type { ChatCompletionChunk } from "~/lib/types/chat-completions"

import {
  createChatCompletionToResponsesStreamState,
  flushChatCompletionToResponsesStreamEvents,
  translateChatCompletionChunkToResponsesStreamEvents,
  translateChatCompletionStreamErrorToResponsesEvent,
} from "~/routes/responses/responses-from-chat"

const chunk = (
  overrides: Partial<ChatCompletionChunk>,
): ChatCompletionChunk => ({
  id: "chatcmpl_stream_123",
  object: "chat.completion.chunk",
  created: 1_714_000_000,
  model: "gpt-4.1",
  choices: [],
  ...overrides,
})

describe("translateChatCompletionChunkToResponsesStreamEvents text", () => {
  it("maps initial, text delta, and finish chunks into ordered Responses stream events", () => {
    const state = createChatCompletionToResponsesStreamState()
    const events = [
      translateChatCompletionChunkToResponsesStreamEvents(
        chunk({
          choices: [
            {
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
              logprobs: null,
            },
          ],
        }),
        state,
      ),
      translateChatCompletionChunkToResponsesStreamEvents(
        chunk({
          choices: [
            {
              index: 0,
              delta: { content: "hello" },
              finish_reason: null,
              logprobs: null,
            },
          ],
        }),
        state,
      ),
      translateChatCompletionChunkToResponsesStreamEvents(
        chunk({
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          copilot_usage: {
            total_nano_aiu: 1_500_000,
          },
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        }),
        state,
      ),
      flushChatCompletionToResponsesStreamEvents(state),
    ].flat()

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(events[1]).toMatchObject({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        status: "in_progress",
      },
    })
    expect(events[2]).toMatchObject({
      type: "response.output_text.delta",
      delta: "hello",
      output_index: 0,
      content_index: 0,
    })
    expect(events[4]).toMatchObject({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        status: "completed",
      },
    })
    expect(events[5]).toMatchObject({
      type: "response.completed",
      response: {
        id: "resp_chatcmpl_stream_123",
        output_text: "hello",
        status: "completed",
        copilot_usage: {
          total_nano_aiu: 1_500_000,
        },
        usage: {
          input_tokens: 3,
          output_tokens: 1,
          total_tokens: 4,
        },
      },
    })
  })
})

describe("translateChatCompletionChunkToResponsesStreamEvents terminal metadata", () => {
  it("waits for trailing cost and usage chunks before completing", () => {
    const state = createChatCompletionToResponsesStreamState()
    const finishEvents = translateChatCompletionChunkToResponsesStreamEvents(
      chunk({
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      }),
      state,
    )
    const costEvents = translateChatCompletionChunkToResponsesStreamEvents(
      chunk({
        choices: [],
        copilot_usage: {
          token_details: [
            {
              batch_size: 1,
              cost_per_batch: 2,
              token_count: 3,
              token_type: "input",
            },
          ],
          total_nano_aiu: 1_500_000,
        },
      }),
      state,
    )
    const usageEvents = translateChatCompletionChunkToResponsesStreamEvents(
      chunk({
        choices: [],
        copilot_usage: { total_nano_aiu: null },
        usage: {
          prompt_tokens: 3,
          completion_tokens: 1,
          total_tokens: 4,
        },
      }),
      state,
    )

    expect(
      [...finishEvents, ...costEvents].some(
        (event) => event.type === "response.completed",
      ),
    ).toBe(false)
    expect(usageEvents).toEqual([])
    const terminalEvents = flushChatCompletionToResponsesStreamEvents(state)
    expect(terminalEvents).toHaveLength(1)
    expect(terminalEvents[0]).toMatchObject({
      type: "response.completed",
      response: {
        copilot_usage: {
          token_details: [
            {
              batch_size: 1,
              cost_per_batch: 2,
              token_count: 3,
              token_type: "input",
            },
          ],
          total_nano_aiu: 1_500_000,
        },
        usage: {
          input_tokens: 3,
          output_tokens: 1,
          total_tokens: 4,
        },
      },
    })
  })
})

describe("translateChatCompletionChunkToResponsesStreamEvents tools", () => {
  it("maps tool call argument deltas into function_call argument events and done", () => {
    const state = createChatCompletionToResponsesStreamState()
    const events = [
      translateChatCompletionChunkToResponsesStreamEvents(
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_weather",
                    type: "function",
                    function: { name: "lookup_weather", arguments: '{"city":' },
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        }),
        state,
      ),
      translateChatCompletionChunkToResponsesStreamEvents(
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"Hangzhou"}' },
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        }),
        state,
      ),
      translateChatCompletionChunkToResponsesStreamEvents(
        chunk({
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
              logprobs: null,
            },
          ],
        }),
        state,
      ),
      flushChatCompletionToResponsesStreamEvents(state),
    ].flat()

    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(events[1]).toMatchObject({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "fc_call_weather",
        type: "function_call",
        status: "in_progress",
      },
    })
    expect(events[2]).toMatchObject({
      item_id: "fc_call_weather",
      output_index: 0,
      delta: '{"city":',
    })
    expect(events[4]).toMatchObject({
      type: "response.function_call_arguments.done",
      item_id: "fc_call_weather",
      output_index: 0,
      name: "lookup_weather",
      arguments: '{"city":"Hangzhou"}',
    })
    expect(events[5]).toMatchObject({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "fc_call_weather",
        type: "function_call",
        status: "completed",
      },
    })
    expect(events[6]).toMatchObject({
      type: "response.completed",
      response: {
        output: [
          {
            type: "function_call",
            call_id: "call_weather",
            name: "lookup_weather",
            arguments: '{"city":"Hangzhou"}',
            status: "completed",
          },
        ],
      },
    })
  })
})

describe("Chat completion generation failures in Responses streams", () => {
  it.each([
    { signal: "finish_reason:error", trailingUsage: false },
    { signal: "finish_reason:error", trailingUsage: true },
    { signal: "top-level error", trailingUsage: false },
    { signal: "top-level error", trailingUsage: true },
  ])("fails once without completing partial outputs for %p", (failure) => {
    const state = createChatCompletionToResponsesStreamState()
    const upstreamError = {
      code: "generation_failed",
      message: "The upstream generator could not finish this completion.",
      type: "server_error",
    }
    const partial = chunk({
      choices: [
        {
          index: 0,
          delta: {
            content: "Partial answer",
            tool_calls: [
              {
                index: 0,
                id: "call_partial",
                type: "function",
                function: { name: "lookup_weather", arguments: '{"city":' },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    })
    const failed = Object.assign(
      chunk({
        choices:
          failure.signal === "finish_reason:error" ?
            [
              {
                index: 0,
                delta: {},
                finish_reason: "error",
                logprobs: null,
              },
            ]
          : [],
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
        copilot_usage: { total_nano_aiu: 1_500_000 },
      }),
      {
        error: failure.signal === "top-level error" ? upstreamError : undefined,
      },
    )
    const inputs = [partial, failed, failed]
    if (failure.trailingUsage) {
      inputs.push(
        chunk({
          usage: { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21 },
          copilot_usage: { total_nano_aiu: 2_500_000 },
        }),
      )
    }
    const events = inputs.flatMap((input) =>
      translateChatCompletionChunkToResponsesStreamEvents(input, state),
    )
    const lateEvents = translateChatCompletionChunkToResponsesStreamEvents(
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              content: "hidden after failure",
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '"hidden after failure"}' },
                },
              ],
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      }),
      state,
    )
    events.push(
      ...lateEvents,
      ...flushChatCompletionToResponsesStreamEvents(state),
      ...flushChatCompletionToResponsesStreamEvents(state),
    )

    expect(
      events
        .filter((event) =>
          [
            "response.completed",
            "response.incomplete",
            "response.failed",
          ].includes(event.type),
        )
        .map((event) => event.type),
    ).toEqual(["response.failed"])
    const terminal = events.find((event) => event.type === "response.failed")
    expect(terminal?.response).toMatchObject({
      status: "failed",
      output_text: "Partial answer",
      usage:
        failure.trailingUsage ?
          { input_tokens: 17, output_tokens: 4, total_tokens: 21 }
        : { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
      copilot_usage: {
        total_nano_aiu: failure.trailingUsage ? 2_500_000 : 1_500_000,
      },
      output: [
        expect.objectContaining({ type: "message", status: "incomplete" }),
        expect.objectContaining({
          type: "function_call",
          call_id: "call_partial",
          arguments: '{"city":',
          status: "incomplete",
        }),
      ],
    })
    expect(typeof terminal?.response.error?.message).toBe("string")
    expect(terminal?.response.error?.message.length).toBeGreaterThan(0)
    if (failure.signal === "top-level error") {
      expect(terminal?.response.error).toMatchObject({
        code: upstreamError.code,
        message: upstreamError.message,
      })
    }
    expect(lateEvents.map((event) => event.type)).not.toContain(
      "response.output_text.delta",
    )
    expect(lateEvents.map((event) => event.type)).not.toContain(
      "response.function_call_arguments.delta",
    )
    const added = events.filter(
      (event) => event.type === "response.output_item.added",
    )
    expect(added).toHaveLength(2)
    for (const event of added) {
      const done = events.filter(
        (candidate) =>
          candidate.type === "response.output_item.done"
          && candidate.item.id === event.item.id,
      )
      expect(done).toHaveLength(1)
      expect(done[0]).toMatchObject({ item: { status: "incomplete" } })
    }
    expect(events.at(-1)?.type).toBe("response.failed")
    for (let index = 1; index < events.length; index++) {
      expect(events[index].sequence_number).toBeGreaterThan(
        events[index - 1].sequence_number,
      )
    }
  })
})

describe("translateChatCompletionStreamErrorToResponsesEvent", () => {
  it("maps stream failures into response.failed", () => {
    const state = createChatCompletionToResponsesStreamState()
    translateChatCompletionChunkToResponsesStreamEvents(
      chunk({ choices: [] }),
      state,
    )

    const event = translateChatCompletionStreamErrorToResponsesEvent(
      new Error("upstream aborted"),
      state,
    )

    expect(event.type).toBe("response.failed")
    expect(event).toMatchObject({
      response: {
        id: "resp_chatcmpl_stream_123",
        status: "failed",
        error: { message: "upstream aborted" },
      },
    })
  })
})
