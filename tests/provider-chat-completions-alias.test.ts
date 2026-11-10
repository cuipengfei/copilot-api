import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import { installModelsDevCatalog } from "~/lib/models-dev-cache"
import { requestContext, type RequestTiming } from "~/lib/request-context"
import { requestEventsMiddleware } from "~/lib/request-events"
import { traceIdMiddleware } from "~/lib/trace"
import type { UsageTokens } from "~/lib/token-usage"

import { modelsDevCatalogFixture } from "./fixtures/models-dev-catalog"

const actualConfigModule = await import("~/lib/config")
const actualTokenUsageModule = await import("~/lib/token-usage")

let providerConfig: ResolvedProviderConfig | null = null
let modelMappings: Record<string, string> = {}
let requestTiming: RequestTiming | undefined

const noopTokenUsageRecorder = () => {}
let restoreTokenUsageRecorder = () => {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: () => providerConfig,
  resolveMappedModel: (model: string) => modelMappings[model] ?? model,
}))

const { completionRoutes } = await import("~/routes/chat-completions/route")

const originalFetch = globalThis.fetch

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            logprobs: null,
            message: {
              content: "answer text",
              role: "assistant",
            },
          },
        ],
        created: 0,
        id: "chatcmpl-test",
        model: "qwen-plus",
        object: "chat.completion",
        usage: {
          completion_tokens: 2,
          prompt_tokens: 8,
          total_tokens: 10,
        },
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    ),
  ),
)

const createApp = () => {
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.use(requestEventsMiddleware(undefined, 4141))
  app.use(async (_c, next) => {
    requestTiming = requestContext.getStore()?.requestTiming
    await next()
  })
  app.route("/v1/chat/completions", completionRoutes)
  return app
}

beforeEach(() => {
  const recorder = spyOn(
    actualTokenUsageModule,
    "createProviderTokenUsageRecorder",
  ).mockImplementation(() => noopTokenUsageRecorder)
  restoreTokenUsageRecorder = () => recorder.mockRestore()
  providerConfig = {
    apiKey: "provider-key",
    authType: "authorization",
    baseUrl: "https://dashscope.example/compatible-mode",
    models: {
      "qwen-plus": {
        extraBody: {
          enable_thinking: true,
          preserve_thinking: true,
        },
        temperature: 0.2,
        topK: 50,
        topP: 0.8,
      },
    },
    name: "dash",
    type: "openai-compatible",
  }

  modelMappings = {}
  requestTiming = undefined
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  restoreTokenUsageRecorder()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfig = null
})

describe("provider/model aliases on top-level chat completions route", () => {
  test.each([true, false])(
    "tracks provider stream completion with DONE=%s",
    async (complete) => {
      const usage = { completion_tokens: 2, prompt_tokens: 8, total_tokens: 10 }
      const recordUsage = mock((_usage: UsageTokens) => {})
      spyOn(
        actualTokenUsageModule,
        "createProviderTokenUsageRecorder",
      ).mockReturnValueOnce(recordUsage)
      fetchMock.mockResolvedValueOnce(
        new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }], usage })}\n\n${complete ? "data: [DONE]\n\n" : ""}`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
      const response = await createApp().request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "dash/qwen-plus",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      const body = await response.text()
      expect(body).toContain("partial")
      expect(body.includes("event: error")).toBe(!complete)
      expect(requestTiming?.outcome).toBe(complete ? "completed" : "error")
      expect(recordUsage).toHaveBeenCalledTimes(1)
      expect(recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          input_tokens: 8,
          output_tokens: 2,
          total_tokens: 10,
        }),
      )
    },
  )

  test("reports provider stream read failures and retains received usage", async () => {
    const recordUsage = mock((_usage: UsageTokens) => {})
    spyOn(
      actualTokenUsageModule,
      "createProviderTokenUsageRecorder",
    ).mockReturnValueOnce(recordUsage)
    let sent = false
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) {
              controller.error(new Error("provider connection reset"))
              return
            }
            sent = true
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n',
              ),
            )
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    const response = await createApp().request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "dash/qwen-plus",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    })
    const body = await response.text()
    expect(body).toContain("event: error")
    expect(body).toContain("upstream_stream_error")
    expect(requestTiming?.outcome).toBe("error")
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ input_tokens: 8, output_tokens: 2 }),
    )
  })

  test("marks JSON-only provider errors as failed requests", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        'data: {"error":{"message":"rate limited"}}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    const response = await createApp().request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "dash/qwen-plus",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    })
    const body = await response.text()
    expect(body).toContain("event: error")
    expect(body).toContain("rate limited")
    expect(body).not.toContain("incomplete_stream")
    expect(requestTiming?.outcome).toBe("error")
  })

  test("forwards a selected models.dev model to its own API URL", async () => {
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      example: {
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.example.com/v1",
        models: {
          "qwen-plus": {
            id: "qwen-plus",
            provider: {
              api: "https://model.example.com/api/v4",
              npm: "@ai-sdk/openai-compatible",
            },
          },
        },
      },
    })
    providerConfig = {
      ...providerConfig!,
      baseUrl: "https://api.example.com/v1",
      modelsDevProviderId: "example",
    }

    const response = await createApp().request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://model.example.com/api/v4/chat/completions",
    )
  })

  test("routes mapped models to provider chat completions before rate limiting", async () => {
    modelMappings = {
      "gpt-provider": "dash/qwen-plus",
    }

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "gpt-provider",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://dashscope.example/compatible-mode/v1/chat/completions",
    )
    expect((init as RequestInit).headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
    })

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
    }
    expect(upstreamBody.model).toBe("qwen-plus")
  })

  test("strips provider prefix and applies provider model defaults", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const upstreamBody = JSON.parse(init.body as string) as Record<
      string,
      unknown
    >
    expect(upstreamBody).toMatchObject({
      enable_thinking: true,
      model: "qwen-plus",
      preserve_thinking: true,
      temperature: 0.2,
      top_k: 50,
      top_p: 0.8,
    })
  })

  test("keeps request fields over provider defaults and adds stream usage option", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        enable_thinking: false,
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
        stream: true,
        stream_options: {
          include_usage: false,
        },
        temperature: 0.4,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const upstreamBody = JSON.parse(init.body as string) as Record<
      string,
      unknown
    >
    expect(upstreamBody.temperature).toBe(0.4)
    expect(upstreamBody.enable_thinking).toBe(false)
    expect(upstreamBody.stream_options).toEqual({
      include_usage: true,
    })
  })

  test("rejects providers without chat completions support", async () => {
    providerConfig = {
      ...(providerConfig as ResolvedProviderConfig),
      type: "openai-responses",
    }

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({
      error: {
        message:
          "Provider 'dash' does not support the /v1/chat/completions endpoint",
        type: "invalid_request_error",
      },
    })
  })
})

describe("context cache on provider chat completions route", () => {
  test("applies context cache for dashscope providers by default", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      name: "dashscope",
      models: {
        "qwen-plus": {
          extraBody: {
            enable_thinking: true,
            preserve_thinking: true,
          },
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [
          { content: "system prompt", role: "system" },
          { content: "hello", role: "user" },
        ],
        model: "dashscope/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }

    const systemMessage = body.messages[0]
    expect(Array.isArray(systemMessage.content)).toBe(true)
    const systemPart = (
      systemMessage.content as Array<Record<string, unknown>>
    )[0]
    expect(systemPart.cache_control).toEqual({ type: "ephemeral" })

    const userMessage = body.messages[1]
    expect(Array.isArray(userMessage.content)).toBe(true)
    const userPart = (userMessage.content as Array<Record<string, unknown>>)[0]
    expect(userPart.cache_control).toEqual({ type: "ephemeral" })
  })

  test("detects dashscope via aliyuncs.com in baseUrl", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://bailian.aliyuncs.com/api/v1",
      name: "my-bailian",
      models: {
        "qwen-plus": {},
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "my-bailian/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    const userMessage = body.messages[0]
    expect(Array.isArray(userMessage.content)).toBe(true)
    const userPart = (userMessage.content as Array<Record<string, unknown>>)[0]
    expect(userPart.cache_control).toEqual({ type: "ephemeral" })
  })

  test("does not apply context cache for non-dashscope providers by default", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://api.example.com/v1",
      name: "custom",
      models: {
        "qwen-plus": {},
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [
          { content: "system prompt", role: "system" },
          { content: "hello", role: "user" },
        ],
        model: "custom/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    for (const message of body.messages) {
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (typeof part === "object" && part !== null) {
            expect(part).not.toHaveProperty("cache_control")
          }
        }
      }
    }
  })

  test("applies context cache for non-dashscope providers when explicitly enabled", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://api.example.com/v1",
      name: "custom",
      models: {
        "qwen-plus": {
          contextCache: true,
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [
          { content: "system prompt", role: "system" },
          { content: "hello", role: "user" },
        ],
        model: "custom/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    const systemMessage = body.messages[0]
    expect(Array.isArray(systemMessage.content)).toBe(true)
    const systemPart = (
      systemMessage.content as Array<Record<string, unknown>>
    )[0]
    expect(systemPart.cache_control).toEqual({ type: "ephemeral" })
  })

  test("disables context cache for dashscope when contextCache is false", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      name: "dashscope",
      models: {
        "qwen-plus": {
          contextCache: false,
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dashscope/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    for (const message of body.messages) {
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (typeof part === "object" && part !== null) {
            expect(part).not.toHaveProperty("cache_control")
          }
        }
      }
    }
  })
})

describe("dashscope preserve_thinking default on chat completions route", () => {
  test("defaults preserve_thinking to true for dashscope when not set", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      name: "dashscope",
      models: {
        "qwen-plus": {},
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dashscope/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.preserve_thinking).toBe(true)
  })

  test("keeps explicit preserve_thinking false from extraBody", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      name: "dashscope",
      models: {
        "qwen-plus": {
          extraBody: {
            preserve_thinking: false,
          },
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dashscope/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.preserve_thinking).toBe(false)
  })

  test("keeps explicit preserve_thinking false from request", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      name: "dashscope",
      models: {
        "qwen-plus": {},
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dashscope/qwen-plus",
        preserve_thinking: false,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.preserve_thinking).toBe(false)
  })

  test("does not set preserve_thinking for non-dashscope providers", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://api.example.com/v1",
      name: "custom",
      models: {
        "qwen-plus": {},
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "custom/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).not.toHaveProperty("preserve_thinking")
  })
})

describe("provider chat generation failures", () => {
  const databaseEnv = "COPILOT_API_SQLITE_DB_PATH"
  let originalDatabasePath: string | undefined

  beforeEach(async () => {
    restoreTokenUsageRecorder()
    restoreTokenUsageRecorder = () => {}
    originalDatabasePath = process.env[databaseEnv]
    await actualTokenUsageModule.closeUsageStore()
    process.env[databaseEnv] = ":memory:"
  })

  afterEach(async () => {
    await actualTokenUsageModule.closeUsageStore()
    if (originalDatabasePath === undefined) {
      Reflect.deleteProperty(process.env, databaseEnv)
    } else {
      process.env[databaseEnv] = originalDatabasePath
    }
  })

  test.each(["finish_reason", "json_error", "sse_error"] as const)(
    "provider HTTP 200 %s emits one safe failure and retains same-message usage once",
    async (kind) => {
      const failure = {
        choices:
          kind === "finish_reason" ?
            [{ index: 0, delta: {}, finish_reason: "error" }]
          : [],
        ...(kind !== "finish_reason" ?
          {
            error: {
              type: "api_error",
              code: "capacity_exhausted",
              message:
                "Generation capacity exhausted. Authorization: Bearer test-token; Copilot-Edits-Session: edits-provider-fixture-secret",
              headers: {
                Authorization: "Bearer test-token",
                "Copilot-Edits-Session": "edits-provider-fixture-secret",
              },
            },
          }
        : {}),
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      }
      const frame = `${kind === "sse_error" ? "event: error\n" : ""}data: ${JSON.stringify(failure)}\n\n`
      fetchMock.mockResolvedValueOnce(
        new Response(`${frame}${frame}data: [DONE]\n\n`, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-usage-ratelimit-session": "rem=5",
          },
        }),
      )
      const response = await createApp().request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "dash/qwen-plus",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body.match(/event: error/g) ?? []).toHaveLength(1)
      if (kind !== "finish_reason") {
        expect(body).toContain("Generation capacity exhausted")
        expect(body).toContain("capacity_exhausted")
        expect(body).toContain("api_error")
      }
      expect(body).not.toContain("test-token")
      expect(body).not.toContain("edits-provider-fixture-secret")
      expect(response.headers.get("x-usage-ratelimit-session")).toBe("rem=5")
      expect(requestTiming?.outcome).toBe("error")
      const events = await actualTokenUsageModule.getTokenUsageEventsPage({
        page: 1,
        pageSize: 10,
        period: "today",
      })
      expect(events.items).toHaveLength(1)
      expect(events.items[0]).toMatchObject({
        source: "provider",
        provider_name: "dash",
        request_outcome: "error",
        input_tokens: 8,
        output_tokens: 2,
        total_tokens: 10,
      })
    },
  )

  test("provider finish_reason:error drains repeated usage after DONE without duplicate failures or billing", async () => {
    const failure = {
      choices: [{ index: 0, delta: {}, finish_reason: "error" }],
    }
    const usage = {
      choices: [],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    }
    fetchMock.mockResolvedValueOnce(
      new Response(
        `data: ${JSON.stringify(failure)}\n\ndata: [DONE]\n\ndata: ${JSON.stringify(usage)}\n\ndata: ${JSON.stringify(usage)}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    const response = await createApp().request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "dash/qwen-plus",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    })
    const body = await response.text()
    expect(body.match(/event: error/g) ?? []).toHaveLength(1)
    expect(requestTiming?.outcome).toBe("error")
    const events = await actualTokenUsageModule.getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "today",
    })
    expect(events.items).toHaveLength(1)
    expect(events.items[0]).toMatchObject({
      request_outcome: "error",
      input_tokens: 8,
      output_tokens: 2,
      total_tokens: 10,
    })
  })

  test.each(["finish_reason", "json_error"] as const)(
    "provider non-streaming HTTP 200 %s returns a failed HTTP result and retains usage once",
    async (kind) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          id: "chatcmpl-provider-failed",
          object: "chat.completion",
          created: 0,
          model: "qwen-plus",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "" },
              finish_reason: kind === "finish_reason" ? "error" : "stop",
            },
          ],
          ...(kind === "json_error" ?
            {
              error: {
                type: "api_error",
                code: "capacity_exhausted",
                message: "Generation capacity exhausted",
              },
            }
          : {}),
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
        }),
      )
      const response = await createApp().request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "dash/qwen-plus",
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
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
      expect(requestTiming?.outcome).toBe("error")
      const events = await actualTokenUsageModule.getTokenUsageEventsPage({
        page: 1,
        pageSize: 10,
        period: "today",
      })
      expect(events.items).toHaveLength(1)
      expect(events.items[0]).toMatchObject({
        request_outcome: "error",
        input_tokens: 8,
        output_tokens: 2,
        total_tokens: 10,
      })
    },
  )
})
