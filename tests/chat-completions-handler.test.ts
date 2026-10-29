import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"
import { Hono } from "hono"
import { SSEStreamingApi } from "hono/streaming"

import { state } from "../src/lib/state"
import * as configPolicy from "../src/lib/config"
import { closeUsageStore } from "../src/lib/token-usage"
import { completionRoutes } from "../src/routes/chat-completions/route"

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

const postChat = (body: Record<string, unknown>) => {
  const app = new Hono()
  app.route("/v1/chat/completions", completionRoutes)
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

const flushMicrotasks = async (turns: number) => {
  for (let index = 0; index < turns; index++) {
    await Promise.resolve()
  }
}

beforeEach(async () => {
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
  if (originalNoColor === undefined) {
    Reflect.deleteProperty(process.env, "NO_COLOR")
  } else {
    process.env.NO_COLOR = originalNoColor
  }
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
  state.accountType = originalState.accountType
  state.copilotToken = originalState.copilotToken
  state.verbose = originalState.verbose
  state.vsCodeVersion = originalState.vsCodeVersion
  state.models = originalState.models
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

describe("chat completions handler logging", () => {
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
      await flushMicrotasks(1000)

      expect(streamLogWrites(stdout.writes).some((w) => w.includes("✓"))).toBe(
        false,
      )
    } finally {
      stdout.restore()
      infoSpy.mockRestore()
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
      expect(logs.at(-1)?.endsWith("\n")).toBe(true)
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

  test("accepts a finish_reason chunk as the terminal event", async () => {
    const finishChunk = {
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
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
      expect(text).toContain('"finish_reason":"stop"')

      const logs = streamLogWrites(stdout.writes)
      const final = logs.at(-1) as string
      expect(final).toStartWith("\x1b[2K\r↪ gpt-test 2 ✓")
      expect(final.endsWith("\n")).toBe(true)
    } finally {
      stdout.restore()
      infoSpy.mockRestore()
    }
  })
})
