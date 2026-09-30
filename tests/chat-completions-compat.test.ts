import { describe, expect, test } from "bun:test"
import type { Server } from "bun"

import type { ChatCompletionsPayload } from "../src/lib/types/chat-completions"

import { HTTPError } from "../src/lib/error"
import {
  ensureChatCompletionOkResponse,
  stripReasoningFields,
  type EnsureChatCompletionOkResponseOptions,
} from "../src/services/copilot/chat-completions-compat"

test("重试仅移除 assistant 的 reasoning 字段并保留工具调用", () => {
  const payload: ChatCompletionsPayload = {
    model: "local-model",
    stream: true,
    messages: [
      { role: "user", content: "继续处理" },
      {
        role: "assistant",
        content: "调用工具",
        reasoning_opaque: "signature",
        reasoning_text: "reasoning",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "结果" },
    ],
  }
  const original = structuredClone(payload)

  const stripped = stripReasoningFields(payload)

  expect(payload).toEqual(original)
  expect(stripped.messages[1]).toEqual({
    role: "assistant",
    content: "调用工具",
    tool_calls: original.messages[1].tool_calls,
  })
  expect(stripped.messages[0]).toBe(payload.messages[0])
  expect(stripped.messages[2]).toBe(payload.messages[2])
  expect(stripped.model).toBe(payload.model)
  expect(stripped.stream).toBe(true)
})

test("没有 reasoning 字段的请求保持原有内容", () => {
  const payload: ChatCompletionsPayload = {
    model: "local-model",
    messages: [{ role: "assistant", content: "已有回答" }],
  }

  expect(stripReasoningFields(payload)).toEqual(payload)
})

describe("ensureChatCompletionOkResponse against local HTTP server", () => {
  const runWithServer = async (
    respond: (count: number) => Response,
    run: (url: string, bodies: Array<unknown>) => Promise<void>,
  ): Promise<void> => {
    const bodies: Array<unknown> = []
    let count = 0
    const server: Server<undefined> = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        count += 1
        bodies.push(await request.json())
        return respond(count)
      },
    })
    try {
      await run(server.url.href, bodies)
    } finally {
      await server.stop(true)
    }
  }

  const thinkingError = () =>
    Response.json(
      { error: { message: "thinking block signature invalid" } },
      { status: 400 },
    )

  const reasoningPayload = (): ChatCompletionsPayload => ({
    model: "local-model",
    stream: false,
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "answer",
        reasoning_opaque: "sig",
        reasoning_text: "thought",
      },
    ],
  })

  const makeOptions = (
    payload: ChatCompletionsPayload,
  ): Omit<EnsureChatCompletionOkResponseOptions, "url" | "response"> => ({
    payload,
    headers: {},
    start: Date.now(),
    modelCallId: "test-call",
  })

  test("passes through ok responses without sending requests", async () => {
    await runWithServer(
      () => Response.json({ ok: true }),
      async (url, bodies) => {
        const response = Response.json({ ok: true })
        const result = await ensureChatCompletionOkResponse({
          url,
          response,
          ...makeOptions(reasoningPayload()),
        })
        expect(result.ok).toBe(true)
        expect(bodies).toHaveLength(0)
      },
    )
  })

  test("retries once with reasoning fields stripped on thinking block error", async () => {
    const payload = reasoningPayload()
    const original = structuredClone(payload)

    await runWithServer(
      () => Response.json({ ok: true }),
      async (url, bodies) => {
        const result = await ensureChatCompletionOkResponse({
          url,
          response: thinkingError(),
          ...makeOptions(payload),
        })
        expect(result.ok).toBe(true)
        expect(bodies).toHaveLength(1)
        const retryBody = bodies[0] as ChatCompletionsPayload
        expect(retryBody.messages[1]).toEqual({
          role: "assistant",
          content: "answer",
        })
        expect(payload).toEqual(original)
      },
    )
  })

  test("throws HTTPError mentioning retry when the retry attempt fails", async () => {
    await runWithServer(
      () => thinkingError(),
      async (url, bodies) => {
        let error: unknown
        try {
          await ensureChatCompletionOkResponse({
            url,
            response: thinkingError(),
            ...makeOptions(reasoningPayload()),
          })
        } catch (caught) {
          error = caught
        }
        expect(error).toBeInstanceOf(HTTPError)
        expect((error as HTTPError).message).toBe(
          "Failed to create chat completions (after retry)",
        )
        expect(bodies).toHaveLength(1)
      },
    )
  })

  test("throws HTTPError without retry when error matches no retry condition", async () => {
    await runWithServer(
      () =>
        Response.json({ error: { message: "rate limited" } }, { status: 429 }),
      async (url, bodies) => {
        let error: unknown
        try {
          await ensureChatCompletionOkResponse({
            url,
            response: Response.json(
              { error: { message: "rate limited" } },
              { status: 429 },
            ),
            ...makeOptions(reasoningPayload()),
          })
        } catch (caught) {
          error = caught
        }
        expect(error).toBeInstanceOf(HTTPError)
        expect((error as HTTPError).message).toBe(
          "Failed to create chat completions",
        )
        expect(bodies).toHaveLength(0)
      },
    )
  })

  test("throws HTTPError without retry for non-400 responses", async () => {
    await runWithServer(
      () => Response.json({ error: { message: "boom" } }, { status: 500 }),
      async (url, bodies) => {
        let error: unknown
        try {
          await ensureChatCompletionOkResponse({
            url,
            response: Response.json(
              { error: { message: "boom" } },
              { status: 500 },
            ),
            ...makeOptions(reasoningPayload()),
          })
        } catch (caught) {
          error = caught
        }
        expect(error).toBeInstanceOf(HTTPError)
        expect((error as HTTPError).message).toBe(
          "Failed to create chat completions",
        )
        expect(bodies).toHaveLength(0)
      },
    )
  })

  test("非 JSON 的 400 错误保留响应原文且不重试", async () => {
    await runWithServer(
      () => Response.json({ ok: true }),
      async (url, bodies) => {
        const response = new Response("thinking block signature invalid", {
          status: 400,
        })
        let error: unknown
        try {
          await ensureChatCompletionOkResponse({
            url,
            response,
            ...makeOptions(reasoningPayload()),
          })
        } catch (caught) {
          error = caught
        }
        expect(error).toBeInstanceOf(HTTPError)
        expect((error as HTTPError).response).toBe(response)
        expect(await response.text()).toBe("thinking block signature invalid")
        expect(bodies).toHaveLength(0)
      },
    )
  })
})
