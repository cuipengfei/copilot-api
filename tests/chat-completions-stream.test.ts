import { describe, expect, test } from "bun:test"
import type { ServerSentEventMessage } from "fetch-event-stream"

import { guardChatCompletionsStream } from "~/lib/chat-completions-stream"
import type { ChatCompletionChunk } from "~/lib/types/chat-completions"

const collect = async (
  chunks: ReadonlyArray<ServerSentEventMessage>,
  failure?: Error,
): Promise<Array<ServerSentEventMessage>> => {
  async function* source() {
    for (const chunk of chunks) {
      await Promise.resolve()
      yield chunk
    }
    if (failure) throw failure
  }

  const result: Array<ServerSentEventMessage> = []
  for await (const { message } of guardChatCompletionsStream(source())) {
    result.push(message)
  }
  return result
}

describe("native chat completion stream completion checks", () => {
  test("returns parsed completion data and a null completion for DONE", async () => {
    const completion: ChatCompletionChunk = {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-test",
      choices: [],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }
    const data = JSON.stringify(completion)
    async function* source() {
      await Promise.resolve()
      yield { data }
      yield { data: "[DONE]" }
    }
    const result = []
    for await (const event of guardChatCompletionsStream(source())) {
      result.push(event)
    }
    expect(result[0]).toEqual({ message: { data }, completion })
    expect(result[1]).toEqual({
      message: { data: "[DONE]" },
      completion: null,
    })
  })

  test("preserves chunks and drains usage even after the terminal marker", async () => {
    const chunks = [
      { data: '{"choices":[{"delta":{"content":"hi"}}]}', id: "1" },
      { data: "[DONE]" },
      { data: '{"choices":[],"usage":{"total_tokens":12}}' },
    ]
    expect(await collect(chunks)).toEqual(chunks)
  })

  test("does not classify a transport error after DONE as incomplete", async () => {
    const chunks = [{ data: " [DONE] " }]
    expect(await collect(chunks, new Error("late close"))).toEqual(chunks)
  })

  test.each([
    { chunks: [] },
    { chunks: [{ data: '{"choices":[]}' }] },
    { chunks: [{ data: '{"choices":[{"delta":{"content":"partial"}}]}' }] },
    { chunks: [{ data: '{"choices":[{"finish_reason":null}]}' }] },
    { chunks: [{ data: '{"choices":[{"finish_reason":42}]}' }] },
  ])("reports clean EOF without a terminal event: %j", async ({ chunks }) => {
    const result = await collect(chunks)
    expect(result.slice(0, -1)).toEqual([...chunks])
    expect(result.at(-1)?.event).toBe("error")
    expect(JSON.parse(result.at(-1)?.data ?? "")).toMatchObject({
      error: { type: "api_error", code: "incomplete_stream" },
    })
  })

  test("converts iterator failures to one structured error", async () => {
    const result = await collect(
      [{ data: "partial" }],
      new Error("transport implementation details"),
    )
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ data: "partial" })
    expect(result[1].event).toBe("error")
    expect(JSON.parse(result[1].data ?? "")).toMatchObject({
      error: { type: "api_error", code: "upstream_stream_error" },
    })
    expect(result[1].data).not.toContain("implementation details")
  })

  test("preserves malformed JSON, comments and non-error JSON", async () => {
    const chunks = [
      { comment: "keepalive" },
      { data: "not-json" },
      { data: "null" },
      { data: '{"error":null,"choices":[]}' },
      { data: "42" },
      { data: '{"choices":[{"delta":{"content":"error"}}]}' },
      { data: "[DONE]" },
    ]
    expect(await collect(chunks)).toEqual(chunks)
  })

  test.each([{ event: "error" }, { event: "error", data: '{"error":null}' }])(
    "normalizes explicit errors without details into one structured error: %j",
    async (chunk) => {
      for (const failure of [undefined, new Error("connection reset")]) {
        const result = await collect(
          [chunk, chunk, { data: "[DONE]" }],
          failure,
        )
        expect(result).toHaveLength(1)
        expect(result[0]?.event).toBe("error")
        const payload = JSON.parse(result[0]?.data ?? "{}") as {
          error?: { message?: string; type?: string }
        }
        expect(typeof payload.error?.type).toBe("string")
        expect(typeof payload.error?.message).toBe("string")
        expect(payload.error?.message?.trim().length).toBeGreaterThan(0)
      }
    },
  )

  test.each(["stop", "length", "tool_calls", "content_filter", ""])(
    "accepts string finish_reason %j without DONE and keeps draining usage",
    async (finishReason) => {
      const chunks = [
        {
          data: JSON.stringify({ choices: [{ finish_reason: finishReason }] }),
        },
        { data: '{"choices":[],"usage":{"total_tokens":12}}' },
      ]
      expect(await collect(chunks)).toEqual(chunks)
      expect(await collect(chunks, new Error("late close"))).toEqual(chunks)
    },
  )

  test("keeps tool call deltas on both sides of a finish_reason", async () => {
    const chunks = [
      {
        data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}]}',
      },
      { data: '{"choices":[{"finish_reason":"tool_calls","delta":{}}]}' },
      {
        data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}',
      },
      { data: '{"choices":[],"usage":{"total_tokens":12}}' },
    ]
    expect(await collect(chunks)).toEqual(chunks)
  })

  test.each([false, true])(
    "reports finish_reason:error as one failure with DONE=%s",
    async (done) => {
      const result = await collect([
        { data: '{"choices":[{"delta":{"content":"partial"}}]}' },
        { data: '{"choices":[{"delta":{},"finish_reason":"error"}]}' },
        ...(done ? [{ data: "[DONE]" }] : []),
      ])
      const errors = result.filter((event) => event.event === "error")
      expect(errors).toHaveLength(1)
      const payload = JSON.parse(errors[0]?.data ?? "{}") as {
        error?: { message?: string; code?: string }
      }
      expect(typeof payload.error?.message).toBe("string")
      expect(payload.error?.message?.trim().length).toBeGreaterThan(0)
      expect(payload.error?.code).not.toBe("incomplete_stream")
      expect(result[0].data).toContain("partial")
    },
  )

  test.each([{ code: "generation_failed" }, { type: "upstream_error" }])(
    "keeps the generic failure reason when metadata only identifies a category for %j",
    async (details) => {
      const completion = {
        choices: [{ delta: {}, finish_reason: "error" }],
      }
      const baseline = await collect([{ data: JSON.stringify(completion) }])
      const annotated = await collect([
        { data: JSON.stringify({ ...completion, copilot_errors: [details] }) },
      ])
      const baselineError = JSON.parse(baseline[0].data ?? "{}") as {
        error: { message: string }
      }
      const annotatedError = JSON.parse(annotated[0].data ?? "{}") as {
        error: { message: string; code?: string; type?: string }
      }
      expect(annotatedError.error.message).toBe(baselineError.error.message)
      expect(annotatedError.error).toMatchObject(details)
    },
  )

  test.each([
    {
      message: "Session expired",
      type: "authentication_error",
      code: "invalid_session",
    },
    {
      message: "Authorization failed",
      type: "authorization_error",
      code: "authorization_failed",
    },
    {
      message: "Missing required secret",
      type: "invalid_request_error",
      code: "secret_missing",
    },
  ])("preserves non-sensitive upstream error details %j", async (details) => {
    const result = await collect([{ data: JSON.stringify({ error: details }) }])
    const payload = JSON.parse(result[0].data ?? "{}") as {
      error: { message: string; type: string; code: string | null }
    }
    expect(payload.error).toEqual(details)
  })

  test("preserves same-message content, metadata and usage before the consumer receives an error", async () => {
    const usage = { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
    const copilotUsage = { total_nano_aiu: 1_612_500 }
    const result = await collect([
      {
        data: JSON.stringify({
          id: "chatcmpl-failed-fragment",
          object: "chat.completion.chunk",
          created: 0,
          model: "gpt-test",
          choices: [
            {
              index: 0,
              delta: { content: "last partial fragment" },
              finish_reason: "error",
            },
          ],
          usage,
          copilot_usage: copilotUsage,
        }),
      },
    ])
    const errorIndex = result.findIndex((event) => event.event === "error")
    expect(errorIndex).toBeGreaterThan(0)
    const beforeError = result
      .slice(0, errorIndex)
      .map((event) => JSON.parse(event.data ?? "{}") as ChatCompletionChunk)
    const partial = beforeError.find((event) =>
      event.choices.some(
        (choice) => choice.delta.content === "last partial fragment",
      ),
    )
    expect(partial).toMatchObject({
      id: "chatcmpl-failed-fragment",
      model: "gpt-test",
      choices: [{ delta: { content: "last partial fragment" } }],
    })
    expect(beforeError.findLast((event) => event.usage)).toMatchObject({
      usage,
      copilot_usage: copilotUsage,
    })
    expect(result.filter((event) => event.event === "error")).toHaveLength(1)
  })

  test.each(["finish_reason", "json_error", "sse_error"] as const)(
    "%s retains same-message usage and drains duplicate trailing usage without repeating errors",
    async (kind) => {
      const usage = { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
      const copilotUsage = {
        total_nano_aiu: 1_612_500,
        token_details: [
          {
            token_type: "input",
            token_count: 8,
            batch_size: 1_000_000,
            cost_per_batch: 25_000_000_000,
          },
        ],
      }
      const failure = {
        ...(kind === "sse_error" ? { event: "error" } : {}),
        data: JSON.stringify({
          choices:
            kind === "finish_reason" ?
              [{ index: 0, delta: {}, finish_reason: "error" }]
            : [],
          error: {
            type: "api_error",
            code: "capacity_exhausted",
            message: "Generation capacity exhausted",
          },
          usage,
          copilot_usage: copilotUsage,
        }),
      }
      const trailingUsage = {
        data: JSON.stringify({
          choices: [],
          usage,
          copilot_usage: copilotUsage,
        }),
      }
      let sourceDrained = false
      async function* source() {
        await Promise.resolve()
        yield failure
        yield failure
        yield { data: "[DONE]" }
        yield trailingUsage
        yield trailingUsage
        sourceDrained = true
      }
      const result = []
      for await (const event of guardChatCompletionsStream(source())) {
        result.push(event)
      }
      const errors = result.filter((event) => event.message.event === "error")
      expect(errors).toHaveLength(1)
      expect(JSON.parse(errors[0]?.message.data ?? "{}")).toMatchObject({
        error: {
          type: "api_error",
          code: "capacity_exhausted",
          message: "Generation capacity exhausted",
        },
      })
      const failureIndex = result.findIndex(
        (event) => event.message.event === "error",
      )
      const usageEvent = result
        .slice(0, failureIndex)
        .findLast((event) => event.completion?.usage)
      expect(usageEvent?.completion).toMatchObject({
        usage,
        copilot_usage: copilotUsage,
      })
      expect(sourceDrained).toBe(true)
    },
  )

  test.each(["finish_reason", "json_error", "sse_error"] as const)(
    "%s preserves upstream error details without exposing credentials",
    async (kind) => {
      const result = await collect([
        {
          ...(kind === "sse_error" ? { event: "error" } : {}),
          data: JSON.stringify({
            choices:
              kind === "finish_reason" ?
                [{ index: 0, delta: {}, finish_reason: "error" }]
              : [],
            error: {
              type: "api_error",
              code: "capacity_exhausted",
              message:
                "Generation capacity exhausted. Authorization: Bearer sk-fixture-secret; Copilot-Edits-Session: edits-fixture-secret",
              headers: {
                Authorization: "Bearer sk-fixture-secret",
                "Copilot-Edits-Session": "edits-fixture-secret",
              },
            },
          }),
        },
        { data: "[DONE]" },
      ])
      const errors = result.filter((event) => event.event === "error")
      expect(errors).toHaveLength(1)
      const data = errors[0]?.data ?? "{}"
      const payload = JSON.parse(data) as {
        error: { type: string; code: string; message: string }
      }
      expect(payload.error).toMatchObject({
        type: "api_error",
        code: "capacity_exhausted",
      })
      expect(payload.error.message).toContain("Generation capacity exhausted")
      expect(JSON.stringify(result)).not.toContain("sk-fixture-secret")
      expect(JSON.stringify(result)).not.toContain("edits-fixture-secret")
    },
  )

  test.each([
    42,
    "not-a-completion",
    [],
    { choices: {} },
    { choices: "invalid" },
    { choices: [null] },
    { choices: [42] },
  ])(
    "forwards malformed completion shape %j without exposing it to consumers",
    async (value) => {
      const data = JSON.stringify(value)
      async function* source() {
        await Promise.resolve()
        yield { data }
        yield { data: '{"choices":[],"usage":{"total_tokens":12}}' }
        yield { data: "[DONE]" }
      }
      const result = []
      for await (const event of guardChatCompletionsStream(source())) {
        result.push(event)
      }
      expect(result[0]).toEqual({ message: { data }, completion: null })
      expect(result[1].completion?.usage?.total_tokens).toBe(12)
      expect(result).toHaveLength(3)
    },
  )
})
