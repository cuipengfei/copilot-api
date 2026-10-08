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

import { state } from "../src/lib/state"
import {
  closeUsageStore,
  type TokenUsageEventsPage,
} from "../src/lib/token-usage"
import { traceIdMiddleware } from "../src/lib/trace"
import { completionRoutes } from "../src/routes/chat-completions/route"
import { tokenUsageRoute } from "../src/routes/token-usage/route"

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

const fetchUsageEvents = async (): Promise<TokenUsageEventsPage> => {
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.route("/token-usage", tokenUsageRoute)
  const response = await app.request(
    "/token-usage/events?period=day&page=1&page_size=20",
  )
  expect(response.status).toBe(200)
  return (await response.json()) as TokenUsageEventsPage
}

const createChatCompletionJson = () => ({
  id: "chatcmpl-test",
  object: "chat.completion" as const,
  created: 0,
  model: "gpt-test",
  choices: [],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
  copilot_usage: {
    token_details: [
      {
        batch_size: 1_000_000,
        cost_per_batch: 25_000_000_000,
        token_count: 12,
        token_type: "input",
      },
      {
        batch_size: 1_000_000,
        cost_per_batch: 2_500_000_000,
        token_count: 100,
        token_type: "cache_read",
      },
      {
        batch_size: 1_000_000,
        cost_per_batch: 3_125_000_000,
        token_count: 20,
        token_type: "cache_write",
      },
      {
        batch_size: 1_000_000,
        cost_per_batch: 200_000_000_000,
        token_count: 5,
        token_type: "output",
      },
    ],
    total_nano_aiu: 1_612_500,
  },
})

const fetchMock = mock(() => {
  return Promise.resolve(
    new Response(JSON.stringify(createChatCompletionJson()), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-quota-snapshot-premium_interactions":
          "ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z",
      },
    }),
  )
})

const createStreamingFetchMock = () =>
  mock(() => {
    return Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
            controller.close()
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-usage-ratelimit-session": "rem=5.7&rst=2026-04-21T06%3A35%3A37Z",
          },
        },
      ),
    )
  })

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

const createApp = () => {
  const app = new Hono()
  app.route("/v1/chat/completions", completionRoutes)
  return app
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

  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
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

describe("chat completions handler", () => {
  test("logs IN model with resolved effort source", async () => {
    const infoSpy = spyOn(consola, "info")
    try {
      const app = createApp()
      const response = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-test",
          reasoning_effort: "medium",
          messages: [{ role: "user", content: "hello" }],
        }),
      })

      expect(response.status).toBe(200)
      expect(
        infoSpy.mock.calls.some(
          (args) =>
            String(args[0]).startsWith("IN gpt-test")
            && String(args[0]).includes("effort=medium (request)"),
        ),
      ).toBe(true)
    } finally {
      infoSpy.mockRestore()
    }
  })

  test("logs IN model without inventing an omitted effort", async () => {
    const infoSpy = spyOn(consola, "info")
    try {
      const app = createApp()
      const response = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-test",
          messages: [{ role: "user", content: "hello" }],
        }),
      })

      expect(response.status).toBe(200)
      expect(infoSpy.mock.calls.some((args) => args[0] === "IN gpt-test")).toBe(
        true,
      )
    } finally {
      infoSpy.mockRestore()
    }
  })

  test("allows gpt-5.4 requests when the model is available", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalled()
  })

  test("forwards upstream quota headers on non-stream success", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-quota-snapshot-premium_interactions")).toBe(
      "ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z",
    )
  })

  test("records copilot_usage cost breakdown for non-stream responses", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(200)
    const events = await fetchUsageEvents()
    expect(events.items).toHaveLength(1)
    expect(events.items[0]?.nano_cost_input).toBe(300_000)
    expect(events.items[0]?.nano_cost_cache_read).toBe(250_000)
    expect(events.items[0]?.nano_cost_cache_write).toBe(62_500)
    expect(events.items[0]?.nano_cost_output).toBe(1_000_000)
    expect(events.items[0]?.total_nano_aiu).toBe(1_612_500)
  })

  test("merges copilot_usage cost breakdown across stream chunks", async () => {
    const usageChunk = {
      id: "chatcmpl-stream-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-test",
      choices: [],
      usage: undefined,
      copilot_usage: {
        token_details: [
          {
            batch_size: 1_000_000,
            cost_per_batch: 25_000_000_000,
            token_count: 12,
            token_type: "input",
          },
          {
            batch_size: 1_000_000,
            cost_per_batch: 2_500_000_000,
            token_count: 100,
            token_type: "cache_read",
          },
          {
            batch_size: 1_000_000,
            cost_per_batch: 3_125_000_000,
            token_count: 20,
            token_type: "cache_write",
          },
          {
            batch_size: 1_000_000,
            cost_per_batch: 200_000_000_000,
            token_count: 5,
            token_type: "output",
          },
        ],
      },
    }
    const totalChunk = {
      ...usageChunk,
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      copilot_usage: { total_nano_aiu: 1_612_500 },
    }
    const streamingFetchMock = mock(() => {
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify(usageChunk)}\n\ndata: ${JSON.stringify(totalChunk)}\n\n`,
                ),
              )
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
              controller.close()
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      )
    })
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      streamingFetchMock as unknown as typeof fetch

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(200)
    await response.text()
    const events = await fetchUsageEvents()
    expect(events.items).toHaveLength(1)
    expect(events.items[0]?.nano_cost_input).toBe(300_000)
    expect(events.items[0]?.nano_cost_cache_read).toBe(250_000)
    expect(events.items[0]?.nano_cost_cache_write).toBe(62_500)
    expect(events.items[0]?.nano_cost_output).toBe(1_000_000)
    expect(events.items[0]?.total_nano_aiu).toBe(1_612_500)
  })

  test("forwards upstream rate-limit headers on stream success", async () => {
    const streamingFetchMock = createStreamingFetchMock()
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      streamingFetchMock as unknown as typeof fetch

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-usage-ratelimit-session")).toBe(
      "rem=5.7&rst=2026-04-21T06%3A35%3A37Z",
    )
  })
})
