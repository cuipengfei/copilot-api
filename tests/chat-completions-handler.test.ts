import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola, { type ConsolaInstance } from "consola"
import { Hono } from "hono"
import { SSEStreamingApi } from "hono/streaming"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { RequestTiming } from "~/lib/request-context"
import type { ChatCompletionChunk } from "~/lib/types/chat-completions"

const originalHome = process.env.COPILOT_API_HOME
const testHome = mkdtempSync(path.join(tmpdir(), "copilot-api-chat-"))
process.env.COPILOT_API_HOME = testHome

// PATHS snapshots COPILOT_API_HOME at import, so load app modules after fixture setup.
const { state } = await import("../src/lib/state")
const configPolicy = await import("../src/lib/config")
const { closeUsageStore, getTokenUsageEventsPage } =
  await import("~/lib/token-usage")
let handlerLogger: ConsolaInstance | undefined
const withTag = consola.withTag.bind(consola)
// The handler must load after this spy to expose its real logger without mocking logs.
const loggerFactory = spyOn(consola, "withTag").mockImplementation((tag) => {
  const logger = withTag(tag)
  if (tag === "chat-completions-handler") handlerLogger = logger
  return logger
})
const { chatCompletionsHandlerDependencies, handleCompletion } =
  await import("~/routes/chat-completions/handler").finally(() => {
    loggerFactory.mockRestore()
  })
const { completionRoutes } =
  await import("../src/routes/chat-completions/route")
const { requestContext } = await import("~/lib/request-context")
const { requestEventsMiddleware } = await import("~/lib/request-events")
const { traceIdMiddleware } = await import("~/lib/trace")
const originalCreateChatCompletions =
  chatCompletionsHandlerDependencies.createChatCompletions

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  models: state.models,
  verbose: state.verbose,
  vsCodeVersion: state.vsCodeVersion,
}
const originalNoColor = process.env.NO_COLOR

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const originalDbPath = process.env[DB_PATH_ENV]
const PREMIUM_HEADER =
  "ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z"
const RATE_LIMIT_HEADER = "rem=5.7&rst=2026-04-21T06%3A35%3A37Z"

const createModels = () => ({
  object: "list" as const,
  data: [
    {
      capabilities: {
        family: "gpt",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "gpt-5.4",
      model_picker_enabled: true,
      name: "gpt-5.4",
      object: "model" as const,
      preview: false,
      vendor: "openai",
      version: "1",
    },
  ],
})

const postChat = (body: Record<string, unknown>, signal?: AbortSignal) => {
  const app = new Hono()
  app.route("/v1/chat/completions", completionRoutes)
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
}

const createChatCompletionJson = () => ({
  id: "chatcmpl-test",
  object: "chat.completion" as const,
  created: 0,
  model: "gpt-test",
  choices: [
    {
      index: 0,
      message: { role: "assistant" as const, content: "hi" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
  copilot_usage: { total_nano_aiu: 1_612_500 },
})

const nonStreamingResponse = () =>
  new Response(JSON.stringify(createChatCompletionJson()), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-quota-snapshot-premium_interactions": PREMIUM_HEADER,
      "x-usage-ratelimit-session": RATE_LIMIT_HEADER,
    },
  })

const contentChunk = (text: string) => ({
  id: "chatcmpl-stream",
  object: "chat.completion.chunk",
  created: 0,
  model: "gpt-test",
  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
})

const usageChunk = {
  id: "chatcmpl-stream",
  object: "chat.completion.chunk",
  created: 0,
  model: "gpt-test",
  choices: [],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
}

const sseBody = (chunks: unknown[]) =>
  `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`

const streamingResponse = (body: string) =>
  new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "x-quota-snapshot-premium_interactions": PREMIUM_HEADER,
      "x-usage-ratelimit-session": RATE_LIMIT_HEADER,
    },
  })

const installFetch = (fetchMock: unknown) => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as typeof fetch
}

const captureStdout = () => {
  const writes: string[] = []
  const spy = spyOn(process.stdout, "write")
  spy.mockImplementation((chunk: string | Uint8Array) => {
    writes.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    )
    return true
  })
  return { writes, restore: () => spy.mockRestore() }
}

const streamLogWrites = (writes: string[]) =>
  writes.filter((write) => write.includes("↪ gpt-test"))

beforeEach(async () => {
  chatCompletionsHandlerDependencies.createChatCompletions =
    originalCreateChatCompletions
  process.env.NO_COLOR = "1"
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.verbose = false
  state.vsCodeVersion = "1.0.0"
  state.models = createModels()
})

afterEach(async () => {
  chatCompletionsHandlerDependencies.createChatCompletions =
    originalCreateChatCompletions
  if (originalNoColor === undefined) {
    Reflect.deleteProperty(process.env, "NO_COLOR")
  } else {
    process.env.NO_COLOR = originalNoColor
  }
  await closeUsageStore()
  if (originalDbPath === undefined) {
    Reflect.deleteProperty(process.env, DB_PATH_ENV)
  } else {
    process.env[DB_PATH_ENV] = originalDbPath
  }
  state.accountType = originalState.accountType
  state.copilotToken = originalState.copilotToken
  state.verbose = originalState.verbose
  state.vsCodeVersion = originalState.vsCodeVersion
  state.models = originalState.models
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

afterAll(async () => {
  await closeUsageStore()
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, "COPILOT_API_HOME")
  } else {
    process.env.COPILOT_API_HOME = originalHome
  }
  rmSync(testHome, { recursive: true, force: true })
})

describe("chat completions handler logging", () => {
  test.each([true, false])(
    "keeps upstream credentials and request bodies out of real debug and failure logs (stream=%s)",
    async (stream) => {
      if (!handlerLogger) {
        throw new Error("Chat completion logger was not captured")
      }
      const bearerToken = "sk-synthetic-failure-log-token"
      const editsSession = "synthetic-failure-log-edits-session"
      const privateBody = "SYNTHETIC_PRIVATE_FAILURE_REQUEST_BODY"
      const failure = {
        ...(stream ? usageChunk : createChatCompletionJson()),
        error: {
          type: "api_error",
          code: "capacity_exhausted",
          message: `Generation capacity exhausted. Authorization: Bearer ${bearerToken}; Copilot-Edits-Session: ${editsSession}; request: ${privateBody}`,
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            "Copilot-Edits-Session": editsSession,
          },
          request: { body: privateBody },
        },
      }
      installFetch(
        mock(() =>
          Promise.resolve(
            stream ?
              streamingResponse(sseBody([contentChunk("partial"), failure]))
            : Response.json(failure),
          ),
        ),
      )
      const logs: Array<{ type: string; text: string }> = []
      const reporter = {
        log: (logObj: { type: string; args: Array<unknown> }) => {
          logs.push({ type: logObj.type, text: JSON.stringify(logObj.args) })
        },
      }
      const previousLevel = consola.level
      const previousHandlerLevel = handlerLogger.level
      const previousVerbose = state.verbose
      consola.level = 5
      handlerLogger.level = 5
      state.verbose = true
      consola.addReporter(reporter)
      handlerLogger.addReporter(reporter)
      const stdout = captureStdout()
      const stderrWrites: string[] = []
      const stderr = spyOn(process.stderr, "write").mockImplementation(
        (chunk: string | Uint8Array) => {
          stderrWrites.push(
            typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
          )
          return true
        },
      )
      try {
        const response = await postChat({
          model: "gpt-test",
          stream,
          messages: [{ role: "user", content: privateBody }],
        })
        expect(response.status).toBe(stream ? 200 : 502)
        const body = await response.text()
        expect(body).toContain("Generation capacity exhausted")
        expect(body).toContain("capacity_exhausted")
        expect(body).toContain("api_error")
        if (stream) {
          expect(body).toContain("event: error")
          expect(body).not.toContain("[DONE]")
        }
        expect(
          logs.some(
            (log) =>
              log.type === "debug" && log.text.includes("Set max_tokens to:"),
          ),
        ).toBe(true)
        expect(
          logs.some(
            (log) =>
              log.type === "error"
              && log.text.includes("capacity_exhausted")
              && log.text.includes("Generation capacity exhausted"),
          ),
        ).toBe(true)
        const output = [
          ...logs.map((log) => log.text),
          ...stdout.writes,
          ...stderrWrites,
        ].join("\n")
        for (const secret of [bearerToken, editsSession, privateBody]) {
          expect(output.includes(secret)).toBe(false)
          expect(body.includes(secret)).toBe(false)
        }
      } finally {
        stderr.mockRestore()
        stdout.restore()
        handlerLogger.removeReporter(reporter)
        consola.removeReporter(reporter)
        handlerLogger.level = previousHandlerLevel
        consola.level = previousLevel
        state.verbose = previousVerbose
      }
    },
  )

  test.each(["progress", "completion"] as const)(
    "stdout %s 写入失败时保留完整 SSE 并关闭流",
    async (phase) => {
      const body = sseBody([
        contentChunk("he"),
        contentChunk("llo"),
        usageChunk,
      ])
      installFetch(mock(() => Promise.resolve(streamingResponse(body))))
      const app = new Hono()
      app.route("/v1/chat/completions", completionRoutes)
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: app.fetch,
      })
      const close = Reflect.get(SSEStreamingApi.prototype, "close")
      let streamClosed = false
      const cleanup = spyOn(
        SSEStreamingApi.prototype,
        "close",
      ).mockImplementation(async function (this: SSEStreamingApi) {
        await close.call(this)
        streamClosed = this.closed
      })
      let failedWrites = 0
      const stdout = spyOn(process.stdout, "write").mockImplementation(
        (chunk: string | Uint8Array) => {
          const text =
            typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
          if (
            text.includes("↪")
            && text.includes("✓") === (phase === "completion")
          ) {
            failedWrites += 1
            throw new Error("stdout unavailable")
          }
          return true
        },
      )
      try {
        const response = await originalFetch(
          new URL("/v1/chat/completions", server.url),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "gpt-test",
              stream: true,
              messages: [{ role: "user", content: "hello" }],
            }),
          },
        )
        expect(response.status).toBe(200)
        expect(await response.text()).toBe(body)
        expect(response.headers.get("x-usage-ratelimit-session")).toBe(
          RATE_LIMIT_HEADER,
        )
        expect(streamClosed).toBe(true)
        expect(failedWrites).toBe(phase === "progress" ? 3 : 1)
      } finally {
        stdout.mockRestore()
        await server.stop(true)
        cleanup.mockRestore()
      }
    },
  )

  test("stdout 写入失败时保留 JSON 响应与 headers", async () => {
    installFetch(mock(() => Promise.resolve(nonStreamingResponse())))
    const stdout = spyOn(process.stdout, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        const text =
          typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
        if (text.includes("↪")) throw new Error("stdout unavailable")
        return true
      },
    )
    try {
      const response = await postChat({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(createChatCompletionJson())
      expect(response.headers.get("x-usage-ratelimit-session")).toBe(
        RATE_LIMIT_HEADER,
      )
    } finally {
      stdout.mockRestore()
    }
  })

  test.each([
    { supported: undefined, expected: "xhigh" },
    { supported: ["low", "medium", "high"], expected: "high" },
    { supported: [], expected: undefined },
  ])(
    "记录与实际上游请求一致的配置 effort：%p",
    async ({ supported, expected }) => {
      const policy = spyOn(
        configPolicy,
        "getReasoningEffortForModel",
      ).mockReturnValue("xhigh")
      state.models!.data[0].capabilities.supports.reasoning_effort =
        supported ? [...supported] : undefined
      let sent: Record<string, unknown> | undefined
      installFetch(
        mock((url: string, init?: RequestInit) => {
          if (url.endsWith("/chat/completions")) {
            if (typeof init?.body !== "string")
              throw new Error("Expected a JSON request body")
            sent = JSON.parse(init.body) as Record<string, unknown>
          }
          return Promise.resolve(nonStreamingResponse())
        }),
      )
      const info = spyOn(consola, "info")
      try {
        const response = await postChat({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hello" }],
        })
        expect(response.status).toBe(200)
        expect(sent?.reasoning_effort).toBe(expected)
        expect(
          info.mock.calls.some(
            (args) =>
              String(args[0])
              === `IN gpt-5.4 [effort=${expected ?? "unsupported"} (config)]`,
          ),
        ).toBe(true)
      } finally {
        info.mockRestore()
        policy.mockRestore()
      }
    },
  )

  test("缺少 quota header 时完成请求不查询 GitHub", async () => {
    const githubToken = state.githubToken
    state.githubToken = "local-log-test-token"
    const requested: Array<string> = []
    installFetch(
      mock((url: string) => {
        requested.push(url)
        return Promise.resolve(Response.json(createChatCompletionJson()))
      }),
    )
    try {
      const response = await postChat({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      })
      expect(response.status).toBe(200)
      expect(((await response.json()) as { id: string }).id).toBe(
        "chatcmpl-test",
      )
      expect(
        requested.filter((url) => url.includes("/copilot_internal/user")),
      ).toEqual([])
    } finally {
      state.githubToken = githubToken
    }
  })

  test("logs a completed zero-chunk line for non-stream responses", async () => {
    installFetch(mock(() => Promise.resolve(nonStreamingResponse())))
    const infoSpy = spyOn(consola, "info")
    const stdout = captureStdout()
    try {
      const response = await postChat({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      })

      expect(response.status).toBe(200)
      expect(
        infoSpy.mock.calls.some(
          (args) => String(args[0]) === "IN gpt-test [effort=high (config)]",
        ),
      ).toBe(true)

      const body = (await response.json()) as { id: string }
      expect(body.id).toBe("chatcmpl-test")
      expect(
        response.headers.get("x-quota-snapshot-premium_interactions"),
      ).toBe(PREMIUM_HEADER)
      expect(response.headers.get("x-usage-ratelimit-session")).toBe(
        RATE_LIMIT_HEADER,
      )

      const logs = streamLogWrites(stdout.writes)
      expect(logs).toHaveLength(1)
      expect(logs[0]).toStartWith("\x1b[2K\r↪ gpt-test 0 ✓")
      expect(logs[0]).toContain("106.5")
      expect(logs[0]).toContain("left")
      expect(logs[0]?.endsWith("\n")).toBe(true)
    } finally {
      stdout.restore()
      infoSpy.mockRestore()
    }
  })

  test("logs request effort source and forwards it upstream", async () => {
    const upstreamBodies: string[] = []
    installFetch(
      mock((url: string, init?: { body?: string }) => {
        if (url.endsWith("/chat/completions")) {
          upstreamBodies.push(init?.body ?? "")
        }
        return Promise.resolve(nonStreamingResponse())
      }),
    )
    const infoSpy = spyOn(consola, "info")
    const stdout = captureStdout()
    try {
      const response = await postChat({
        model: "gpt-test",
        reasoning_effort: "medium",
        messages: [{ role: "user", content: "hello" }],
      })

      expect(response.status).toBe(200)
      expect(
        infoSpy.mock.calls.some(
          (args) => String(args[0]) === "IN gpt-test [effort=medium (request)]",
        ),
      ).toBe(true)

      expect(JSON.parse(upstreamBodies[0] ?? "{}")).toMatchObject({
        reasoning_effort: "medium",
      })
      expect(streamLogWrites(stdout.writes)).toHaveLength(1)
    } finally {
      stdout.restore()
      infoSpy.mockRestore()
    }
  })

  test("increments one stdout line per streamed chunk and finishes once", async () => {
    installFetch(
      mock(() =>
        Promise.resolve(
          streamingResponse(
            sseBody([contentChunk("he"), contentChunk("llo"), usageChunk]),
          ),
        ),
      ),
    )
    const infoSpy = spyOn(consola, "info")
    const stdout = captureStdout()
    try {
      const response = await postChat({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      })

      expect(response.status).toBe(200)
      expect(
        response.headers.get("x-quota-snapshot-premium_interactions"),
      ).toBe(PREMIUM_HEADER)
      expect(response.headers.get("x-usage-ratelimit-session")).toBe(
        RATE_LIMIT_HEADER,
      )

      const text = await response.text()
      expect(text).toContain('"content":"he"')
      expect(text).toContain('"content":"llo"')
      expect(text).toContain("[DONE]")
      expect(
        infoSpy.mock.calls.some(
          (args) => String(args[0]) === "IN gpt-test [effort=high (config)]",
        ),
      ).toBe(true)

      const logs = streamLogWrites(stdout.writes)
      expect(logs).toHaveLength(4)
      const progress = logs.slice(0, -1)
      const final = logs.at(-1) as string
      expect(progress.map((write) => write.includes("✓"))).toEqual([
        false,
        false,
        false,
      ])
      expect(progress.map((write) => write.endsWith("\n"))).toEqual([
        false,
        false,
        false,
      ])
      const counts = progress.map((write) =>
        Number(/↪ gpt-test (\d+)/.exec(write)?.[1]),
      )
      expect(counts).toEqual([1, 2, 3])
      expect(final).toStartWith("\x1b[2K\r↪ gpt-test 3 ✓")
      expect(final).toContain("left")
      expect(final.endsWith("\n")).toBe(true)
      expect(logs.filter((write) => write.includes("✓"))).toHaveLength(1)
    } finally {
      stdout.restore()
      infoSpy.mockRestore()
    }
  })

  test("does not log a success line when the upstream stream fails", async () => {
    installFetch(
      mock(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify(contentChunk("he"))}\n\n`,
                  ),
                )
                controller.error(new Error("stream exploded"))
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        ),
      ),
    )
    const infoSpy = spyOn(consola, "info")
    const errorSpy = spyOn(console, "error")
    errorSpy.mockImplementation(() => {})
    const stdout = captureStdout()
    try {
      const response = await postChat({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      })

      expect(response.status).toBe(200)
      await response.text()
      expect(streamLogWrites(stdout.writes).some((w) => w.includes("✓"))).toBe(
        false,
      )
    } finally {
      stdout.restore()
      errorSpy.mockRestore()
      infoSpy.mockRestore()
    }
  })

  test("does not log a success line when the client cancels the stream", async () => {
    const gate = Promise.withResolvers<void>()
    installFetch(
      mock(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify(contentChunk("he"))}\n\n`,
                  ),
                )
                void gate.promise.then(() => {
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify(contentChunk("llo"))}\n\n`,
                    ),
                  )
                  controller.enqueue(
                    new TextEncoder().encode("data: [DONE]\n\n"),
                  )
                  controller.close()
                })
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        ),
      ),
    )
    const infoSpy = spyOn(consola, "info")
    const stdout = captureStdout()
    const close = Reflect.get(SSEStreamingApi.prototype, "close")
    const closeSettled = Promise.withResolvers<void>()
    const closeSpy = spyOn(SSEStreamingApi.prototype, "close")
    closeSpy.mockImplementation(async function (this: SSEStreamingApi) {
      await close.call(this)
      closeSettled.resolve()
    })
    try {
      const response = await postChat({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      })
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      await reader.read()
      await reader.cancel()
      gate.resolve()
      await closeSettled.promise

      expect(streamLogWrites(stdout.writes).some((w) => w.includes("✓"))).toBe(
        false,
      )
    } finally {
      gate.resolve()
      stdout.restore()
      infoSpy.mockRestore()
      closeSpy.mockRestore()
    }
  })

  test("does not log a success line when the request signal aborts mid-stream", async () => {
    const gate = Promise.withResolvers<void>()
    const head = `data: ${JSON.stringify(contentChunk("he"))}\n\n`
    const tail = sseBody([contentChunk("llo"), usageChunk])
    installFetch(
      mock(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                const encoder = new TextEncoder()
                controller.enqueue(encoder.encode(head))
                void gate.promise.then(() => {
                  controller.enqueue(encoder.encode(tail))
                  controller.close()
                })
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        ),
      ),
    )
    const stdout = captureStdout()
    const close = Reflect.get(SSEStreamingApi.prototype, "close")
    const closeSpy = spyOn(SSEStreamingApi.prototype, "close")
    const closeSettled = Promise.withResolvers<void>()
    let streamClosed = false
    closeSpy.mockImplementation(async function (this: SSEStreamingApi) {
      await close.call(this)
      streamClosed = this.closed
      closeSettled.resolve()
    })
    try {
      const abort = new AbortController()
      const response = await postChat(
        {
          model: "gpt-test",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        },
        abort.signal,
      )
      expect(response.status).toBe(200)
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
      await closeSettled.promise

      const logs = streamLogWrites(stdout.writes)
      expect(logs.some((write) => write.includes("✓"))).toBe(false)
      const final = logs.at(-1) as string
      expect(final).toStartWith("\x1b[2K\r↪ gpt-test 3")
      expect(final.endsWith("\n")).toBe(true)
      expect(body).toContain('"content":"llo"')
      expect(body).toContain('"total_tokens":17')
      expect(body).toContain("[DONE]")
      expect(streamClosed).toBe(true)
      const events = await getTokenUsageEventsPage({
        page: 1,
        pageSize: 10,
        period: "today",
      })
      expect(events.items).toHaveLength(1)
      expect(events.items[0]).toMatchObject({
        input_tokens: 12,
        output_tokens: 5,
      })
    } finally {
      gate.resolve()
      stdout.restore()
      closeSpy.mockRestore()
    }
  })

  test("does not log a success line when upstream sends an SSE error event", async () => {
    installFetch(
      mock(() =>
        Promise.resolve(
          streamingResponse(
            `event: error\ndata: {"error":{"message":"upstream boom"}}\n\n`,
          ),
        ),
      ),
    )
    const infoSpy = spyOn(consola, "info")
    const stdout = captureStdout()
    try {
      const response = await postChat({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      })

      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('"message":"upstream boom"')
      expect(text).not.toContain("[DONE]")

      const logs = streamLogWrites(stdout.writes)
      expect(logs.some((write) => write.includes("✓"))).toBe(false)
    } finally {
      stdout.restore()
      infoSpy.mockRestore()
    }
  })

  test("does not log a success line when the stream ends without a terminal event", async () => {
    installFetch(
      mock(() =>
        Promise.resolve(
          streamingResponse(`data: ${JSON.stringify(contentChunk("he"))}\n\n`),
        ),
      ),
    )
    const infoSpy = spyOn(consola, "info")
    const stdout = captureStdout()
    try {
      const response = await postChat({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      })

      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('"content":"he"')
      expect(text).not.toContain("[DONE]")
      expect(text).toContain("event: error")
      expect(text).toContain('"code":"incomplete_stream"')

      const logs = streamLogWrites(stdout.writes)
      expect(logs.some((write) => write.includes("✓"))).toBe(false)
      const final = logs.at(-1) as string
      expect(final).toStartWith("\x1b[2K\r↪ gpt-test 1")
      expect(final.endsWith("\n")).toBe(true)
    } finally {
      stdout.restore()
      infoSpy.mockRestore()
    }
  })

  test.each(["stop", "tool_calls", ""])(
    "accepts string finish_reason %j as the terminal event without DONE",
    async (finishReason) => {
      const finishChunk = {
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        created: 0,
        model: "gpt-test",
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      }
      installFetch(
        mock(() =>
          Promise.resolve(
            streamingResponse(
              `data: ${JSON.stringify(contentChunk("he"))}\n\ndata: ${JSON.stringify(finishChunk)}\n\n`,
            ),
          ),
        ),
      )
      const infoSpy = spyOn(consola, "info")
      const stdout = captureStdout()
      try {
        const response = await postChat({
          model: "gpt-test",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        })

        expect(response.status).toBe(200)
        const text = await response.text()
        expect(text).toContain('"content":"he"')
        expect(text).toContain(JSON.stringify(finishChunk))
        expect(text).not.toContain("incomplete_stream")

        const logs = streamLogWrites(stdout.writes)
        const final = logs.at(-1) as string
        expect(final).toStartWith("\x1b[2K\r↪ gpt-test 2 ✓")
        expect(final.endsWith("\n")).toBe(true)
      } finally {
        stdout.restore()
        infoSpy.mockRestore()
      }
    },
  )
})

describe("native chat completions usage and outcomes", () => {
  const createChatCompletions = mock(originalCreateChatCompletions)
  let requestTiming: RequestTiming | undefined

  beforeEach(() => {
    createChatCompletions.mockReset()
    requestTiming = undefined
    chatCompletionsHandlerDependencies.createChatCompletions =
      createChatCompletions
  })

  test("native chat completions stream records usage when the upstream iterator throws", async () => {
    createChatCompletions.mockImplementationOnce(() =>
      Promise.resolve(
        streamChunks([
          chunk({
            content: "partial",
            usage: {
              completion_tokens: 2,
              prompt_tokens: 5,
              total_tokens: 7,
            },
          }),
          { error: new Error("upstream connection reset") },
        ]),
      ),
    )
    const response = await requestCompletion()
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("partial")
    expect(body).toContain("event: error")
    expect(body).toContain('"code":"upstream_stream_error"')
    expect(body).not.toContain("[DONE]")
    expect(requestTiming?.outcome).toBe("error")

    const usageEvents = await getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "today",
    })
    expect(usageEvents.items).toHaveLength(1)
    expect(usageEvents.items[0]).toMatchObject({
      endpoint: "chat_completions",
      input_tokens: 5,
      model: "gpt-test",
      output_tokens: 2,
      total_tokens: 7,
    })
  })

  test("native chat completions stream records usage after an invalid JSON chunk", async () => {
    createChatCompletions.mockImplementationOnce(() =>
      Promise.resolve(
        streamChunks([
          { data: "not-json" },
          chunk({
            content: "after",
            usage: {
              completion_tokens: 3,
              prompt_tokens: 8,
              total_tokens: 11,
            },
          }),
          { data: "[DONE]" },
        ]),
      ),
    )

    const response = await requestCompletion()
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain("after")
    expect(body).not.toContain("event: error")
    expect(requestTiming?.outcome).toBe("completed")

    const usageEvents = await getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "today",
    })
    expect(usageEvents.items).toHaveLength(1)
    expect(usageEvents.items[0]).toMatchObject({
      input_tokens: 8,
      output_tokens: 3,
      total_tokens: 11,
    })
  })

  test("native chat completions reports missing terminal events and retains partial usage", async () => {
    createChatCompletions.mockResolvedValueOnce(
      streamChunks([
        chunk({
          content: "partial",
          usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
        }),
      ]),
    )
    const response = await requestCompletion()
    const body = await response.text()
    expect(body).toContain("partial")
    expect(body).toContain("event: error")
    expect(body).toContain('"code":"incomplete_stream"')
    expect(requestTiming?.outcome).toBe("error")
    const events = await getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "today",
    })
    expect(events.items).toHaveLength(1)
    expect(events.items[0]).toMatchObject({ input_tokens: 6, output_tokens: 3 })
  })

  test("native chat completions tracks JSON-only errors as failures even after DONE", async () => {
    createChatCompletions.mockResolvedValueOnce(
      streamChunks([
        { data: '{"error":{"message":"overloaded","type":"api_error"}}' },
        { data: "[DONE]" },
        chunk({
          content: "",
          usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
        }),
      ]),
    )
    const stdout = captureStdout()
    try {
      const response = await requestCompletion()
      const body = await response.text()
      expect(body).toContain("event: error")
      expect(body).toContain("overloaded")
      expect(body).not.toContain("incomplete_stream")
      expect(requestTiming?.outcome).toBe("error")
      expect(
        streamLogWrites(stdout.writes).some((write) => write.includes("✓")),
      ).toBe(false)
      const events = await getTokenUsageEventsPage({
        page: 1,
        pageSize: 10,
        period: "today",
      })
      expect(events.items).toHaveLength(1)
      expect(events.items[0]).toMatchObject({
        input_tokens: 6,
        output_tokens: 3,
      })
    } finally {
      stdout.restore()
    }
  })

  test("native chat completions drains final usage after the client disconnects", async () => {
    const { promise: usageReady, resolve: releaseUsage } =
      Promise.withResolvers<void>()
    const { promise: upstreamFinished, resolve: finishUpstream } =
      Promise.withResolvers<void>()
    async function* upstream() {
      try {
        yield { data: '{"choices":[{"delta":{"content":"partial"}}]}' }
        await usageReady
        yield chunk({
          content: "",
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        })
        yield { data: "[DONE]" }
      } finally {
        finishUpstream()
      }
    }
    createChatCompletions.mockResolvedValueOnce(upstream())
    const stdout = captureStdout()
    const close = Reflect.get(SSEStreamingApi.prototype, "close")
    const closeSettled = Promise.withResolvers<void>()
    const closeSpy = spyOn(SSEStreamingApi.prototype, "close")
    closeSpy.mockImplementation(async function (this: SSEStreamingApi) {
      await close.call(this)
      closeSettled.resolve()
    })
    try {
      const response = await requestCompletion()
      const reader = response.body!.getReader()
      try {
        expect((await reader.read()).done).toBe(false)
        await reader.cancel()
      } finally {
        releaseUsage()
      }
      await upstreamFinished
      await closeSettled.promise
      expect(requestTiming?.hasUsage).toBe(true)
      expect(requestTiming?.outcome).toBe("cancelled")
      expect(
        streamLogWrites(stdout.writes).some((write) => write.includes("✓")),
      ).toBe(false)
      const events = await getTokenUsageEventsPage({
        page: 1,
        pageSize: 10,
        period: "today",
      })
      expect(events.items).toHaveLength(1)
      expect(events.items[0]).toMatchObject({
        input_tokens: 12,
        output_tokens: 7,
      })
    } finally {
      releaseUsage()
      stdout.restore()
      closeSpy.mockRestore()
    }
  })

  test.each(["stop", "tool_calls", ""])(
    "native chat completions accepts a finish_reason-only stream (%j)",
    async (finishReason) => {
      createChatCompletions.mockResolvedValueOnce(
        streamChunks([
          {
            data: JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            }),
          },
        ]),
      )
      const stdout = captureStdout()
      try {
        const response = await requestCompletion()
        const body = await response.text()
        expect(body).toContain('"finish_reason":')
        expect(body).not.toContain("event: error")
        expect(body).not.toContain("[DONE]")
        expect(requestTiming?.outcome).toBe("completed")
        const logs = streamLogWrites(stdout.writes)
        expect(logs.filter((write) => write.includes("✓"))).toHaveLength(1)
        expect(logs.at(-1)).toStartWith("\x1b[2K\r↪ gpt-test 1 ✓")
      } finally {
        stdout.restore()
      }
    },
  )

  test.each([
    { value: [] },
    { value: {} },
    { value: { choices: {} } },
    { value: { choices: [null] } },
    { value: { choices: [42] } },
  ])(
    "native chat completions drains usage after unsafe JSON shape %j",
    async ({ value }) => {
      createChatCompletions.mockResolvedValueOnce(
        streamChunks([
          { data: JSON.stringify(value) },
          chunk({
            content: "after",
            usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
          }),
          { data: "[DONE]" },
        ]),
      )
      const response = await requestCompletion()
      const body = await response.text()
      expect(body).toContain(JSON.stringify(value))
      expect(body).toContain("after")
      expect(body).not.toContain("event: error")
      expect(requestTiming?.outcome).toBe("completed")
      const events = await getTokenUsageEventsPage({
        page: 1,
        pageSize: 10,
        period: "today",
      })
      expect(events.items).toHaveLength(1)
      expect(events.items[0]).toMatchObject({
        input_tokens: 8,
        output_tokens: 3,
      })
    },
  )

  test("native chat completions retains Copilot details while draining usage after finish_reason", async () => {
    createChatCompletions.mockResolvedValueOnce(
      streamChunks([
        {
          data: JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            copilot_usage: {
              token_details: [
                {
                  token_type: "input",
                  token_count: 8,
                  batch_size: 1_000_000,
                  cost_per_batch: 25_000_000_000,
                },
              ],
            },
          }),
        },
        {
          data: JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 5,
              total_tokens: 17,
              prompt_tokens_details: { cached_tokens: 4 },
            },
            copilot_usage: { total_nano_aiu: 1_612_500 },
          }),
        },
      ]),
    )
    const response = await requestCompletion()
    const body = await response.text()
    expect(body).toContain('"total_tokens":17')
    expect(body).not.toContain("incomplete_stream")
    expect(requestTiming?.outcome).toBe("completed")
    const events = await getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "today",
    })
    expect(events.items).toHaveLength(1)
    expect(events.items[0]).toMatchObject({
      input_tokens: 8,
      cache_read_input_tokens: 4,
      output_tokens: 5,
      total_tokens: 17,
      total_nano_aiu: 1_612_500,
      nano_cost_input: 200_000,
    })
  })

  test.each(["same-message", "trailing", "repeated"] as const)(
    "HTTP 200 finish_reason:error fails the request and records %s usage once",
    async (placement) => {
      chatCompletionsHandlerDependencies.createChatCompletions =
        originalCreateChatCompletions
      const usage = {
        ...usageChunk.usage,
        prompt_tokens_details: { cached_tokens: 4 },
      }
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
        ...contentChunk(""),
        choices: [{ index: 0, delta: {}, finish_reason: "error" }],
        ...(placement === "same-message" ?
          { usage, copilot_usage: copilotUsage }
        : {}),
      }
      const billedUsage = {
        ...usageChunk,
        usage,
        copilot_usage: copilotUsage,
      }
      const failures = placement === "repeated" ? [failure, failure] : [failure]
      const trailingUsage =
        placement === "same-message" ? []
        : placement === "repeated" ? [billedUsage, billedUsage]
        : [billedUsage]
      const body =
        sseBody([contentChunk("partial"), ...failures])
        + trailingUsage
          .map((value) => `data: ${JSON.stringify(value)}\n\n`)
          .join("")
      installFetch(mock(() => Promise.resolve(streamingResponse(body))))
      const stdout = captureStdout()
      try {
        const response = await requestCompletion()
        expect(response.status).toBe(200)
        const text = await response.text()
        expect(text).toContain("partial")
        expect(text.match(/event: error/g) ?? []).toHaveLength(1)
        const errorFrame = text
          .split("\n\n")
          .find((frame) => frame.includes("event: error"))
        const errorData = errorFrame
          ?.split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6)
        const error = JSON.parse(errorData ?? "{}") as {
          error?: { message?: string }
        }
        expect(error.error?.message?.trim().length).toBeGreaterThan(0)
        expect(requestTiming?.outcome).toBe("error")
        expect(
          streamLogWrites(stdout.writes).some((write) => write.includes("✓")),
        ).toBe(false)
        expect(response.headers.get("x-usage-ratelimit-session")).toBe(
          RATE_LIMIT_HEADER,
        )
        const events = await getTokenUsageEventsPage({
          page: 1,
          pageSize: 10,
          period: "today",
        })
        expect(events.items).toHaveLength(1)
        expect(events.items[0]).toMatchObject({
          endpoint: "chat_completions",
          request_outcome: "error",
          input_tokens: 8,
          cache_read_input_tokens: 4,
          output_tokens: 5,
          total_tokens: 17,
          total_nano_aiu: 1_612_500,
          nano_cost_input: 200_000,
        })
      } finally {
        stdout.restore()
      }
    },
  )

  test.each(["json_error", "sse_error"] as const)(
    "HTTP 200 %s preserves safe details and same-message billing without duplicate errors",
    async (kind) => {
      chatCompletionsHandlerDependencies.createChatCompletions =
        originalCreateChatCompletions
      const failure = {
        ...usageChunk,
        copilot_usage: { total_nano_aiu: 1_612_500 },
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
      }
      const frame = `${kind === "sse_error" ? "event: error\n" : ""}data: ${JSON.stringify(failure)}\n\n`
      installFetch(
        mock(() =>
          Promise.resolve(
            streamingResponse(
              `data: ${JSON.stringify(contentChunk("partial"))}\n\n${frame}${frame}data: [DONE]\n\n`,
            ),
          ),
        ),
      )
      const stdout = captureStdout()
      try {
        const response = await requestCompletion()
        expect(response.status).toBe(200)
        const body = await response.text()
        expect(body).toContain("partial")
        expect(body.match(/event: error/g) ?? []).toHaveLength(1)
        expect(body).toContain("Generation capacity exhausted")
        expect(body).toContain("capacity_exhausted")
        expect(body).toContain("api_error")
        expect(body).not.toContain("sk-fixture-secret")
        expect(body).not.toContain("edits-fixture-secret")
        expect(requestTiming?.outcome).toBe("error")
        expect(
          streamLogWrites(stdout.writes).some((write) => write.includes("✓")),
        ).toBe(false)
        const events = await getTokenUsageEventsPage({
          page: 1,
          pageSize: 10,
          period: "today",
        })
        expect(events.items).toHaveLength(1)
        expect(events.items[0]).toMatchObject({
          request_outcome: "error",
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17,
          total_nano_aiu: 1_612_500,
        })
      } finally {
        stdout.restore()
      }
    },
  )

  test.each(["finish_reason", "json_error"] as const)(
    "non-streaming HTTP 200 %s returns a failed HTTP result and bills consumed usage once",
    async (kind) => {
      chatCompletionsHandlerDependencies.createChatCompletions =
        originalCreateChatCompletions
      const upstream = createChatCompletionJson()
      upstream.choices[0].finish_reason =
        kind === "finish_reason" ? "error" : "stop"
      installFetch(
        mock(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                ...upstream,
                ...(kind === "json_error" ?
                  {
                    error: {
                      type: "api_error",
                      code: "capacity_exhausted",
                      message: "Generation capacity exhausted",
                    },
                  }
                : {}),
              }),
              {
                status: 200,
                headers: {
                  "content-type": "application/json",
                  "x-usage-ratelimit-session": RATE_LIMIT_HEADER,
                },
              },
            ),
          ),
        ),
      )
      const stdout = captureStdout()
      try {
        const response = await requestCompletion(false)
        const body = (await response.json()) as {
          error?: { message?: string; type?: string; code?: string }
        }
        expect(response.status).toBeGreaterThanOrEqual(400)
        expect(response.status).toBeLessThan(600)
        expect(body.error?.message?.trim().length).toBeGreaterThan(0)
        if (kind === "json_error") {
          expect(body.error).toMatchObject({
            type: "api_error",
            code: "capacity_exhausted",
            message: "Generation capacity exhausted",
          })
        }
        expect(response.headers.get("x-usage-ratelimit-session")).toBe(
          RATE_LIMIT_HEADER,
        )
        expect(requestTiming?.outcome).toBe("error")
        expect(
          streamLogWrites(stdout.writes).some((write) => write.includes("✓")),
        ).toBe(false)
        const events = await getTokenUsageEventsPage({
          page: 1,
          pageSize: 10,
          period: "today",
        })
        expect(events.items).toHaveLength(1)
        expect(events.items[0]).toMatchObject({
          request_outcome: "error",
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17,
          total_nano_aiu: 1_612_500,
        })
      } finally {
        stdout.restore()
      }
    },
  )

  const requestCompletion = async (stream = true): Promise<Response> => {
    const app = new Hono()
    app.use(traceIdMiddleware)
    app.use(requestEventsMiddleware(undefined, 4141))
    app.use(async (_c, next) => {
      requestTiming = requestContext.getStore()?.requestTiming
      await next()
    })
    app.post("/v1/chat/completions", handleCompletion)
    return app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-test",
        stream,
      }),
    })
  }

  const chunk = (input: {
    content: string
    usage: {
      completion_tokens: number
      prompt_tokens: number
      total_tokens: number
    }
  }): { data: string } => {
    const payload: ChatCompletionChunk = {
      choices: [
        {
          delta: { content: input.content },
          finish_reason: null,
          index: 0,
          logprobs: null,
        },
      ],
      created: 0,
      id: "chatcmpl-test",
      model: "gpt-test",
      object: "chat.completion.chunk",
      usage: input.usage,
    }
    return { data: JSON.stringify(payload) }
  }

  async function* streamChunks(
    chunks: Array<{ data?: string; error?: Error }>,
  ): AsyncGenerator<{ data: string }> {
    for (const chunk of chunks) {
      await Promise.resolve()
      if (chunk.error) {
        throw chunk.error
      }
      yield { data: chunk.data ?? "" }
    }
  }
})
