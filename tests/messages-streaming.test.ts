import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"
import { SSEStreamingApi } from "hono/streaming"

import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import type {
  ChatCompletionChunk,
  ChatCompletionsPayload,
} from "~/lib/types/chat-completions"
import type { ResponsesPayload, ResponsesResult } from "~/lib/types/responses"

import { closeUsageStore } from "~/lib/token-usage"
import {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
  messagesApiFlowDependencies,
} from "~/routes/messages/api-flows"
import { responsesUtilsDependencies } from "~/routes/responses/utils"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

const defaultMessagesApiFlowDependencies = { ...messagesApiFlowDependencies }
const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }

const logger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Parameters<typeof handleWithChatCompletions>[2]["logger"]

const captureStreamLogs = () => {
  const writes: Array<string> = []
  const spy = spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      writes.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      )
      return true
    },
  )
  return {
    entries: () =>
      writes
        .filter((write) => write.startsWith("\x1b[2K\r"))
        .map((write) => write.slice("\x1b[2K\r".length)),
    restore: () => spy.mockRestore(),
  }
}

async function* chatStream(
  chunks: Array<ChatCompletionChunk | "[DONE]">,
): AsyncGenerator<{ data: string }> {
  for (const chunk of chunks) {
    await Promise.resolve()
    yield { data: typeof chunk === "string" ? chunk : JSON.stringify(chunk) }
  }
}

async function* messagesStream(
  events: Array<{ data: string; event: string }>,
): AsyncGenerator<{ data: string; event: string }> {
  for (const event of events) {
    await Promise.resolve()
    yield event
  }
}

async function* responsesStream(
  events: Array<Record<string, unknown>>,
): AsyncGenerator<{ data: string }> {
  for (const event of events) {
    await Promise.resolve()
    yield { data: JSON.stringify(event) }
  }
}

const createChatChunk = (
  model: string,
  delta: ChatCompletionChunk["choices"][number]["delta"],
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
): ChatCompletionChunk => ({
  choices: [{ delta, finish_reason: finishReason, index: 0, logprobs: null }],
  created: 0,
  id: "chatcmpl-test",
  model,
  object: "chat.completion.chunk",
})

const createResponsesResult = (model: string): ResponsesResult => ({
  created_at: 0,
  error: null,
  id: "resp-test",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model,
  object: "response",
  output: [],
  output_text: "",
  parallel_tool_calls: false,
  status: "completed",
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: null,
})

const createStreamPayload = (model: string): AnthropicMessagesPayload => ({
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
  model,
  stream: true,
})

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  responsesUtilsDependencies.getModelResponsesApiCompactThreshold = () =>
    undefined
  responsesUtilsDependencies.isContextManagementEnabledForMessages = () => true
  responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
    false
})

afterEach(async () => {
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  Object.assign(messagesApiFlowDependencies, defaultMessagesApiFlowDependencies)
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
})

describe("messages Chat Completions stream log", () => {
  test("advances the count on one line and marks completion", async () => {
    messagesApiFlowDependencies.createChatCompletions = (
      _payload: ChatCompletionsPayload,
    ) =>
      Promise.resolve(
        chatStream([
          createChatChunk("gpt-test", { content: "hello" }),
          createChatChunk("gpt-test", {}, "stop"),
          "[DONE]",
        ]),
      )
    const logs = captureStreamLogs()
    try {
      const app = new Hono()
      app.post("/", (c) =>
        handleWithChatCompletions(c, createStreamPayload("gpt-test"), {
          logger,
          requestId: "request-1",
        }),
      )

      const response = await app.request("/", { method: "POST" })
      const body = await response.text()

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      )
      expect(body).toContain("event: message_stop")
    } finally {
      logs.restore()
    }

    const entries = logs.entries()
    expect(entries).toHaveLength(3)
    expect(entries[0].endsWith(" 1")).toBe(true)
    expect(entries[1].endsWith(" 2")).toBe(true)
    expect(entries[2].endsWith(" 2 ✓\n")).toBe(true)
  })

  test("does not mark completion when the stream ends without finishing", async () => {
    messagesApiFlowDependencies.createChatCompletions = (
      _payload: ChatCompletionsPayload,
    ) =>
      Promise.resolve(
        chatStream([createChatChunk("gpt-test", { content: "partial" })]),
      )
    const logs = captureStreamLogs()
    try {
      const app = new Hono()
      app.post("/", (c) =>
        handleWithChatCompletions(c, createStreamPayload("gpt-test"), {
          logger,
          requestId: "request-1",
        }),
      )

      const response = await app.request("/", { method: "POST" })
      const body = await response.text()

      expect(body).toContain("event: error")
    } finally {
      logs.restore()
    }

    const entries = logs.entries()
    expect(entries).toHaveLength(2)
    expect(entries[0].endsWith(" 1")).toBe(true)
    expect(entries[1]).not.toContain("✓")
    expect(entries[1].endsWith(" 1\n")).toBe(true)
  })

  test("does not mark completion when the upstream throws after finishing", async () => {
    messagesApiFlowDependencies.createChatCompletions = (() =>
      (async function* (): AsyncGenerator<{ data: string }> {
        await Promise.resolve()
        yield {
          data: JSON.stringify(createChatChunk("gpt-test", { content: "hi" })),
        }
        yield {
          data: JSON.stringify(createChatChunk("gpt-test", {}, "stop")),
        }
        throw new Error("upstream connection reset")
      })()) as unknown as typeof messagesApiFlowDependencies.createChatCompletions
    const logs = captureStreamLogs()
    try {
      const app = new Hono()
      app.post("/", (c) =>
        handleWithChatCompletions(c, createStreamPayload("gpt-test"), {
          logger,
          requestId: "request-1",
        }),
      )

      await (await app.request("/", { method: "POST" })).text()
    } finally {
      logs.restore()
    }

    const entries = logs.entries()
    expect(entries).toHaveLength(3)
    expect(entries[1].endsWith(" 2")).toBe(true)
    expect(entries[2]).not.toContain("✓")
    expect(entries[2].endsWith(" 2\n")).toBe(true)
  })

  test("does not mark completion when the request signal aborts mid-stream", async () => {
    const gate = Promise.withResolvers<void>()
    messagesApiFlowDependencies.createChatCompletions = () =>
      Promise.resolve(
        (async function* () {
          yield {
            data: JSON.stringify(
              createChatChunk("gpt-test", { content: "he" }),
            ),
          }
          await gate.promise
          yield {
            data: JSON.stringify(
              createChatChunk("gpt-test", { content: "llo" }),
            ),
          }
          yield {
            data: JSON.stringify({
              ...createChatChunk("gpt-test", {}, "stop"),
              usage: {
                completion_tokens: 5,
                prompt_tokens: 12,
                total_tokens: 17,
              },
            }),
          }
          yield { data: "[DONE]" }
        })(),
      )
    const logs = captureStreamLogs()
    const close = Reflect.get(SSEStreamingApi.prototype, "close")
    const closeSettled = Promise.withResolvers<boolean>()
    const closeSpy = spyOn(SSEStreamingApi.prototype, "close")
    closeSpy.mockImplementation(async function (this: SSEStreamingApi) {
      await close.call(this)
      closeSettled.resolve(this.closed)
    })
    try {
      const app = new Hono()
      app.post("/", (c) =>
        handleWithChatCompletions(c, createStreamPayload("gpt-test"), {
          logger,
          requestId: "abort-signal-chat",
        }),
      )
      const abort = new AbortController()
      const response = await app.request("/", {
        method: "POST",
        signal: abort.signal,
      })
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let body = ""
      const read = async () => {
        const { done, value } = await reader.read()
        if (done) return false
        body += decoder.decode(value, { stream: true })
        return true
      }
      await read()
      abort.abort()
      gate.resolve()
      let more = true
      while (more) more = await read()

      expect(body).toContain('"text":"llo"')
      expect(body).toContain('"output_tokens":5')
      expect(body).toContain("event: message_stop")
      const closed = await closeSettled.promise
      expect(closed).toBe(true)
    } finally {
      gate.resolve()
      logs.restore()
      closeSpy.mockRestore()
    }
    const entries = logs.entries()
    expect(entries.some((entry) => entry.includes("✓"))).toBe(false)
    expect(entries.at(-1)?.endsWith(" 3\n")).toBe(true)
  })
})

describe("messages native Messages stream log", () => {
  test("counts raw events and marks message_stop completion", async () => {
    messagesApiFlowDependencies.createMessages = () =>
      Promise.resolve(
        messagesStream([
          {
            event: "message_start",
            data: JSON.stringify({
              type: "message_start",
              message: {
                id: "msg-1",
                type: "message",
                role: "assistant",
                content: [],
                model: "claude-test",
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            }),
          },
          {
            event: "message_delta",
            data: JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            }),
          },
          {
            event: "message_stop",
            data: JSON.stringify({ type: "message_stop" }),
          },
        ]),
      )
    const logs = captureStreamLogs()
    try {
      const app = new Hono()
      app.post("/", (c) =>
        handleWithMessagesApi(c, createStreamPayload("claude-test"), {
          logger,
          requestId: "request-1",
        }),
      )

      const response = await app.request("/", { method: "POST" })
      const body = await response.text()

      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      )
      expect(body).toContain("event: message_stop")
    } finally {
      logs.restore()
    }

    const entries = logs.entries()
    expect(entries).toHaveLength(4)
    expect(entries[0].endsWith(" 1")).toBe(true)
    expect(entries[2].endsWith(" 3")).toBe(true)
    expect(entries[3].endsWith(" 3 ✓\n")).toBe(true)
  })

  test("does not mark completion for an error terminal event", async () => {
    messagesApiFlowDependencies.createMessages = () =>
      Promise.resolve(
        messagesStream([
          {
            event: "message_start",
            data: JSON.stringify({
              type: "message_start",
              message: {
                id: "msg-1",
                type: "message",
                role: "assistant",
                content: [],
                model: "claude-test",
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            }),
          },
          {
            event: "error",
            data: JSON.stringify({
              type: "error",
              error: { type: "api_error", message: "boom" },
            }),
          },
        ]),
      )
    const logs = captureStreamLogs()
    try {
      const app = new Hono()
      app.post("/", (c) =>
        handleWithMessagesApi(c, createStreamPayload("claude-test"), {
          logger,
          requestId: "request-1",
        }),
      )

      await (await app.request("/", { method: "POST" })).text()
    } finally {
      logs.restore()
    }

    const entries = logs.entries()
    expect(entries).toHaveLength(3)
    expect(entries[1].endsWith(" 2")).toBe(true)
    expect(entries[2]).not.toContain("✓")
    expect(entries[2].endsWith(" 2\n")).toBe(true)
  })

  test("does not mark completion when the request signal aborts mid-stream", async () => {
    const gate = Promise.withResolvers<void>()
    messagesApiFlowDependencies.createMessages = () =>
      Promise.resolve(
        (async function* () {
          yield {
            event: "message_start",
            data: JSON.stringify({
              type: "message_start",
              message: {
                id: "msg-1",
                type: "message",
                role: "assistant",
                content: [],
                model: "claude-test",
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            }),
          }
          await gate.promise
          yield {
            event: "message_delta",
            data: JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            }),
          }
          yield {
            event: "message_stop",
            data: JSON.stringify({ type: "message_stop" }),
          }
        })(),
      )
    const logs = captureStreamLogs()
    const close = Reflect.get(SSEStreamingApi.prototype, "close")
    const closeSettled = Promise.withResolvers<boolean>()
    const closeSpy = spyOn(SSEStreamingApi.prototype, "close")
    closeSpy.mockImplementation(async function (this: SSEStreamingApi) {
      await close.call(this)
      closeSettled.resolve(this.closed)
    })
    try {
      const app = new Hono()
      app.post("/", (c) =>
        handleWithMessagesApi(c, createStreamPayload("claude-test"), {
          logger,
          requestId: "abort-signal-messages",
        }),
      )
      const abort = new AbortController()
      const response = await app.request("/", {
        method: "POST",
        signal: abort.signal,
      })
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let body = ""
      const read = async () => {
        const { done, value } = await reader.read()
        if (done) return false
        body += decoder.decode(value, { stream: true })
        return true
      }
      await read()
      abort.abort()
      gate.resolve()
      let more = true
      while (more) more = await read()

      expect(body).toContain("event: message_start")
      expect(body).toContain('"output_tokens":1')
      expect(body).toContain("event: message_stop")
      const closed = await closeSettled.promise
      expect(closed).toBe(true)
    } finally {
      gate.resolve()
      logs.restore()
      closeSpy.mockRestore()
    }
    const entries = logs.entries()
    expect(entries.some((entry) => entry.includes("✓"))).toBe(false)
    expect(entries.at(-1)?.endsWith(" 3\n")).toBe(true)
  })
})

describe("messages Responses stream log", () => {
  test("marks completion for response.completed", async () => {
    messagesApiFlowDependencies.createResponses = (
      _payload: ResponsesPayload,
    ) =>
      Promise.resolve(
        responsesStream([
          {
            type: "response.created",
            response: createResponsesResult("gpt-test"),
          },
          {
            type: "response.completed",
            response: createResponsesResult("gpt-test"),
          },
        ]),
      )
    const logs = captureStreamLogs()
    try {
      const app = new Hono()
      app.post("/", (c) =>
        handleWithResponsesApi(c, createStreamPayload("gpt-test"), {
          logger,
          requestId: "request-1",
        }),
      )

      const response = await app.request("/", { method: "POST" })
      const body = await response.text()

      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      )
      expect(body).toContain("event: message_stop")
    } finally {
      logs.restore()
    }

    const entries = logs.entries()
    expect(entries).toHaveLength(3)
    expect(entries[1].endsWith(" 2")).toBe(true)
    expect(entries[2].endsWith(" 2 ✓\n")).toBe(true)
  })

  test("does not mark completion for response.failed", async () => {
    messagesApiFlowDependencies.createResponses = (
      _payload: ResponsesPayload,
    ) =>
      Promise.resolve(
        responsesStream([
          {
            type: "response.created",
            response: createResponsesResult("gpt-test"),
          },
          {
            type: "response.failed",
            response: {
              ...createResponsesResult("gpt-test"),
              error: { code: "server_error", message: "boom" },
              status: "failed",
            },
          },
        ]),
      )
    const logs = captureStreamLogs()
    try {
      const app = new Hono()
      app.post("/", (c) =>
        handleWithResponsesApi(c, createStreamPayload("gpt-test"), {
          logger,
          requestId: "request-1",
        }),
      )

      await (await app.request("/", { method: "POST" })).text()
    } finally {
      logs.restore()
    }

    const entries = logs.entries()
    expect(entries).toHaveLength(3)
    expect(entries[1].endsWith(" 2")).toBe(true)
    expect(entries[2]).not.toContain("✓")
    expect(entries[2].endsWith(" 2\n")).toBe(true)
  })

  test("does not mark completion when the request signal aborts mid-stream", async () => {
    const gate = Promise.withResolvers<void>()
    messagesApiFlowDependencies.createResponses = () =>
      Promise.resolve(
        (async function* () {
          yield {
            data: JSON.stringify({
              type: "response.created",
              response: createResponsesResult("gpt-test"),
            }),
          }
          await gate.promise
          yield {
            data: JSON.stringify({
              type: "response.output_text.delta",
              output_index: 0,
              content_index: 0,
              delta: "llo",
            }),
          }
          yield {
            data: JSON.stringify({
              type: "response.completed",
              response: {
                ...createResponsesResult("gpt-test"),
                usage: {
                  input_tokens: 12,
                  output_tokens: 5,
                  total_tokens: 17,
                },
              },
            }),
          }
        })(),
      )
    const logs = captureStreamLogs()
    const close = Reflect.get(SSEStreamingApi.prototype, "close")
    const closeSettled = Promise.withResolvers<boolean>()
    const closeSpy = spyOn(SSEStreamingApi.prototype, "close")
    closeSpy.mockImplementation(async function (this: SSEStreamingApi) {
      await close.call(this)
      closeSettled.resolve(this.closed)
    })
    try {
      const app = new Hono()
      app.post("/", (c) =>
        handleWithResponsesApi(c, createStreamPayload("gpt-test"), {
          logger,
          requestId: "abort-signal-responses",
        }),
      )
      const abort = new AbortController()
      const response = await app.request("/", {
        method: "POST",
        signal: abort.signal,
      })
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let body = ""
      const read = async () => {
        const { done, value } = await reader.read()
        if (done) return false
        body += decoder.decode(value, { stream: true })
        return true
      }
      await read()
      abort.abort()
      gate.resolve()
      let more = true
      while (more) more = await read()

      expect(body).toContain('"text":"llo"')
      expect(body).toContain('"output_tokens":5')
      expect(body).toContain("event: message_stop")
      const closed = await closeSettled.promise
      expect(closed).toBe(true)
    } finally {
      gate.resolve()
      logs.restore()
      closeSpy.mockRestore()
    }
    const entries = logs.entries()
    expect(entries.some((entry) => entry.includes("✓"))).toBe(false)
    expect(entries.at(-1)?.endsWith(" 3\n")).toBe(true)
  })
})

test("Messages 最终事件发送失败时关闭流，不打印成功标记", async () => {
  messagesApiFlowDependencies.createChatCompletions = () =>
    Promise.resolve(
      chatStream([
        createChatChunk("gpt-test", { content: "hello" }),
        createChatChunk("gpt-test", {}, "stop"),
        "[DONE]",
      ]),
    )
  const write = Reflect.get(SSEStreamingApi.prototype, "writeSSE")
  const failure = spyOn(
    SSEStreamingApi.prototype,
    "writeSSE",
  ).mockImplementation(async function (this: SSEStreamingApi, message) {
    if (message.event === "message_stop") throw new Error("client write failed")
    await write.call(this, message)
  })
  const logs = captureStreamLogs()
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const app = new Hono()
    app.post("/", (c) =>
      handleWithChatCompletions(c, createStreamPayload("gpt-test"), {
        logger,
        requestId: "flush-write-error",
      }),
    )
    const response = await app.request("/", { method: "POST" })
    await response.text()
    expect(logs.entries().some((entry) => entry.includes("✓"))).toBe(false)
    expect(logs.entries().at(-1)?.endsWith("\n")).toBe(true)
  } finally {
    logs.restore()
    failure.mockRestore()
    errors.mockRestore()
  }
})
