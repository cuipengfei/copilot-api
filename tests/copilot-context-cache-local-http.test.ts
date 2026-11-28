import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Hono } from "hono"

import { invalidateAutoSession } from "~/lib/auto-session"
import { shutdownLoggerRuntime } from "~/lib/logger"
import { state } from "~/lib/state"
import { closeUsageStore } from "~/lib/token-usage"
import { traceIdMiddleware } from "~/lib/http/trace"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/lib/types/chat-completions"
import type { Model } from "~/lib/types/models"
import * as actualTelemetry from "~/services/telemetry/telemetry"

const mockUndiciRequest = mock(() =>
  Promise.reject(new Error("Unexpected MSFT telemetry request")),
)
const scheduleFeedbackEvents = mock(() => {})
const schedulePostResponseEvents = mock(() => {})

// Test loading boundary: static imports would evaluate routes before these mocks.
const actualUndici = await import("undici")

await mock.module("undici", () => ({
  ...actualUndici,
  request: mockUndiciRequest,
}))
await mock.module("~/services/telemetry/telemetry", () => ({
  ...actualTelemetry,
  initTelemetry: () => {},
  scheduleFeedbackEvents,
  schedulePostResponseEvents,
  trackAuthNewToken: () => {},
  trackGhostTextShown: () => {},
  trackPanelRequest: () => {},
  trackRequestSent: () => {},
  trackResponseError: () => {},
  trackResponseSuccess: () => {},
}))

const { completionRoutes } = await import("~/routes/chat-completions/route")
const { messageRoutes } = await import("~/routes/messages/route")
const { responsesRoutes } = await import("~/routes/responses/route")

const GEMINI_MODEL = "local-gemini"
const GPT_MODEL = "local-gpt"
const TEST_TOKEN = "local-cache-test-token"
const SESSION_ID = "local-cache-test-session"
const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const LOG_DIR_ENV = "COPILOT_API_LOG_DIR"
const cacheControl = { type: "ephemeral" } as const
const geminiConversation: ChatCompletionsPayload["messages"] = [
  { role: "user", content: "first user" },
  { role: "assistant", content: "first assistant" },
  { role: "user", content: "middle user" },
  { role: "assistant", content: "middle assistant" },
  { role: "user", content: "latest user" },
  { role: "assistant", content: "latest assistant" },
]
const expectedGeminiConversation: ChatCompletionsPayload["messages"] = [
  { role: "system", content: "system prompt" },
  { role: "user", content: "first user" },
  {
    role: "assistant",
    content: "first assistant",
    copilot_cache_control: cacheControl,
  },
  { role: "user", content: "middle user" },
  {
    role: "assistant",
    content: "middle assistant",
    copilot_cache_control: cacheControl,
  },
  {
    role: "user",
    content: "latest user",
    copilot_cache_control: cacheControl,
  },
  {
    role: "assistant",
    content: "latest assistant",
    copilot_cache_control: cacheControl,
  },
]

interface RecordedUpstreamRequest {
  path: string
  body: string
}

const originalState = {
  accountType: state.accountType,
  copilotApiUrl: state.copilotApiUrl,
  copilotTelemetryEnabled: state.copilotTelemetryEnabled,
  copilotToken: state.copilotToken,
  forceAgent: state.forceAgent,
  macMachineId: state.macMachineId,
  models: state.models,
  nativeMessages: state.nativeMessages,
  tokenBasedBilling: state.tokenBasedBilling,
  verbose: state.verbose,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  vsCodeVersion: state.vsCodeVersion,
}
const originalEnv = {
  [DB_PATH_ENV]: process.env[DB_PATH_ENV],
  [LOG_DIR_ENV]: process.env[LOG_DIR_ENV],
}

const upstreamRequests: Array<RecordedUpstreamRequest> = []

const chatResponse = (model: string): ChatCompletionResponse => ({
  id: "chatcmpl-local-cache",
  object: "chat.completion",
  created: 0,
  model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok" },
      logprobs: null,
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const body = await request.text()
    upstreamRequests.push({ path: url.pathname, body })

    if (url.pathname !== "/chat/completions") {
      return new Response("not found", { status: 404 })
    }

    const payload = JSON.parse(body) as ChatCompletionsPayload
    return Response.json(chatResponse(payload.model))
  },
})
const serverUrl = `http://127.0.0.1:${server.port}`

const app = new Hono()
app.use(traceIdMiddleware)
app.route("/v1/chat/completions", completionRoutes)
app.route("/v1/messages", messageRoutes)
app.route("/v1/responses", responsesRoutes)

const createModel = (id: string, family: string): Model => ({
  capabilities: {
    family,
    limits: { max_output_tokens: 128 },
    object: "model_capabilities",
    supports: {},
    tokenizer: "o200k_base",
    type: "chat",
  },
  id,
  model_picker_enabled: true,
  name: id,
  object: "model",
  preview: false,
  vendor: "test",
  version: "1",
  supported_endpoints: ["/chat/completions"],
})

let tempDir: string
let dbCounter = 0

const post = (route: string, payload: unknown) =>
  app.request(route, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "session-id": SESSION_ID,
    },
    body: JSON.stringify(payload),
  })

const upstreamPayload = (): ChatCompletionsPayload => {
  expect(upstreamRequests).toHaveLength(1)
  expect(upstreamRequests[0].path).toBe("/chat/completions")
  return JSON.parse(upstreamRequests[0].body) as ChatCompletionsPayload
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-context-cache-"))
})

beforeEach(async () => {
  process.env[DB_PATH_ENV] = path.join(tempDir, `usage-${++dbCounter}.sqlite`)
  process.env[LOG_DIR_ENV] = path.join(tempDir, "logs")
  await closeUsageStore()
  mockUndiciRequest.mockClear()
  scheduleFeedbackEvents.mockClear()
  schedulePostResponseEvents.mockClear()

  state.copilotToken = TEST_TOKEN
  state.copilotApiUrl = serverUrl
  state.copilotTelemetryEnabled = false
  state.forceAgent = false
  state.accountType = "individual"
  state.nativeMessages = false
  state.tokenBasedBilling = false
  state.verbose = false
  state.macMachineId = "machine-local-cache"
  state.vsCodeDeviceId = "device-local-cache"
  state.vsCodeSessionId = "session-local-cache"
  state.vsCodeVersion = "1.120.0"
  state.models = {
    object: "list",
    data: [createModel(GEMINI_MODEL, "Gemini"), createModel(GPT_MODEL, "gpt")],
  }

  upstreamRequests.length = 0
})

afterEach(async () => {
  await closeUsageStore()
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }

  Object.assign(state, originalState)
  invalidateAutoSession()
  const requestCount = upstreamRequests.length
  upstreamRequests.length = 0

  expect(scheduleFeedbackEvents).toHaveBeenCalledTimes(requestCount)
  expect(schedulePostResponseEvents).toHaveBeenCalledTimes(requestCount)
  expect(mockUndiciRequest).toHaveBeenCalledTimes(0)
})

afterAll(async () => {
  await server.stop(true)
  shutdownLoggerRuntime()
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe("Copilot context cache over local HTTP", () => {
  test("direct Chat Completions uses the Gemini four-marker selection", async () => {
    const response = await post("/v1/chat/completions", {
      model: GEMINI_MODEL,
      messages: [
        { role: "system", content: "system prompt" },
        ...geminiConversation,
      ],
    })

    expect(response.status).toBe(200)
    expect(upstreamPayload().messages).toEqual(expectedGeminiConversation)
  })

  test("Messages uses Gemini selection on its first cache pass", async () => {
    const response = await post("/v1/messages", {
      model: GEMINI_MODEL,
      max_tokens: 64,
      system: "system prompt",
      messages: geminiConversation,
    })

    expect(response.status).toBe(200)
    expect(upstreamPayload().messages).toEqual(expectedGeminiConversation)
  })

  test("Responses fallback shares the Gemini four-marker selection", async () => {
    const response = await post("/v1/responses", {
      model: GEMINI_MODEL,
      instructions: "system prompt",
      input: geminiConversation,
    })

    expect(response.status).toBe(200)
    expect(upstreamPayload().messages).toEqual(expectedGeminiConversation)
  })

  test("direct Chat Completions marks only the end of each consecutive tool batch", async () => {
    const tools: NonNullable<ChatCompletionsPayload["tools"]> = [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Look up a value",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    ]
    const response = await post("/v1/chat/completions", {
      model: GEMINI_MODEL,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "latest user" },
        {
          role: "assistant",
          content: null,
          reasoning_text: "first tool plan",
          reasoning_opaque: "opaque-first",
          tool_calls: [
            {
              id: "call-a-1",
              type: "function",
              function: { name: "lookup", arguments: '{"query":"a1"}' },
            },
            {
              id: "call-a-2",
              type: "function",
              function: { name: "lookup", arguments: '{"query":"a2"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-a-1", content: "result a1" },
        { role: "tool", tool_call_id: "call-a-2", content: "result a2" },
        { role: "assistant", content: "between tool rounds" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-b-1",
              type: "function",
              function: { name: "lookup", arguments: '{"query":"b1"}' },
            },
            {
              id: "call-b-2",
              type: "function",
              function: { name: "lookup", arguments: '{"query":"b2"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-b-1", content: "result b1" },
        { role: "tool", tool_call_id: "call-b-2", content: "result b2" },
        {
          role: "assistant",
          content: "final answer",
          reasoning_content: "final reasoning",
        },
      ],
      tools,
      tool_choice: "auto",
    })

    expect(response.status).toBe(200)
    const payload = upstreamPayload()
    expect(payload.tools).toEqual(tools)
    expect(payload.tool_choice).toBe("auto")
    expect(payload.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "latest user" },
      {
        role: "assistant",
        content: null,
        reasoning_text: "first tool plan",
        reasoning_opaque: "opaque-first",
        tool_calls: [
          {
            id: "call-a-1",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"a1"}' },
          },
          {
            id: "call-a-2",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"a2"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-a-1", content: "result a1" },
      {
        role: "tool",
        tool_call_id: "call-a-2",
        content: "result a2",
        copilot_cache_control: cacheControl,
      },
      {
        role: "assistant",
        content: "between tool rounds",
        copilot_cache_control: cacheControl,
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-b-1",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"b1"}' },
          },
          {
            id: "call-b-2",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"b2"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-b-1", content: "result b1" },
      {
        role: "tool",
        tool_call_id: "call-b-2",
        content: "result b2",
        copilot_cache_control: cacheControl,
      },
      {
        role: "assistant",
        content: "final answer",
        reasoning_content: "final reasoning",
        copilot_cache_control: cacheControl,
      },
    ])
  })

  test("direct Chat Completions preserves four existing markers without additions", async () => {
    const messages: ChatCompletionsPayload["messages"] = [
      {
        role: "system",
        content: "",
        copilot_cache_control: cacheControl,
      },
      {
        role: "user",
        content: null,
        copilot_cache_control: cacheControl,
      },
      {
        role: "assistant",
        content: [],
        copilot_cache_control: cacheControl,
      },
      {
        role: "developer",
        content: "client marker",
        copilot_cache_control: cacheControl,
      },
      { role: "user", content: "latest user" },
      { role: "assistant", content: "latest assistant" },
    ]

    const response = await post("/v1/chat/completions", {
      model: GEMINI_MODEL,
      messages,
    })

    expect(response.status).toBe(200)
    expect(upstreamPayload().messages).toEqual(messages)
  })

  test("direct Chat Completions preserves more than four existing markers", async () => {
    const messages: ChatCompletionsPayload["messages"] = [
      {
        role: "system",
        content: "system prompt",
        copilot_cache_control: cacheControl,
      },
      {
        role: "user",
        content: "older user",
        copilot_cache_control: cacheControl,
      },
      {
        role: "assistant",
        content: "older assistant",
        copilot_cache_control: cacheControl,
      },
      {
        role: "user",
        content: "latest user",
        copilot_cache_control: cacheControl,
      },
      {
        role: "assistant",
        content: "latest assistant",
        copilot_cache_control: cacheControl,
      },
      { role: "assistant", content: "unmarked candidate" },
    ]

    const response = await post("/v1/chat/completions", {
      model: GEMINI_MODEL,
      messages: JSON.parse(
        JSON.stringify(messages),
      ) as ChatCompletionsPayload["messages"],
    })

    expect(response.status).toBe(200)
    expect(upstreamPayload().messages).toEqual(messages)
  })

  test("direct Chat Completions does not add markers on a serialized replay", async () => {
    const request = {
      model: GEMINI_MODEL,
      messages: [
        { role: "system", content: "system prompt" },
        ...geminiConversation,
      ],
    }
    const firstResponse = await post("/v1/chat/completions", request)

    expect(firstResponse.status).toBe(200)
    const firstPayload = upstreamPayload()
    expect(firstPayload.messages).toEqual(expectedGeminiConversation)

    const replay = JSON.parse(
      JSON.stringify(firstPayload),
    ) as ChatCompletionsPayload
    const replayResponse = await post("/v1/chat/completions", replay)

    expect(replayResponse.status).toBe(200)
    expect(upstreamRequests).toHaveLength(2)
    expect(upstreamRequests[1].path).toBe("/chat/completions")
    expect(JSON.parse(upstreamRequests[1].body)).toEqual(firstPayload)
  })

  test("direct Chat Completions does not add markers for non-Gemini metadata", async () => {
    const messages: ChatCompletionsPayload["messages"] = [
      { role: "system", content: "system prompt" },
      ...geminiConversation,
    ]
    const response = await post("/v1/chat/completions", {
      model: GPT_MODEL,
      messages,
    })

    expect(response.status).toBe(200)
    expect(upstreamPayload().messages).toEqual(messages)
  })

  test("Messages retains legacy markers for non-Gemini metadata", async () => {
    const response = await post("/v1/messages", {
      model: GPT_MODEL,
      max_tokens: 64,
      system: "system prompt",
      messages: geminiConversation,
    })

    expect(response.status).toBe(200)
    expect(upstreamPayload().messages).toEqual([
      {
        role: "system",
        content: "system prompt",
        copilot_cache_control: cacheControl,
      },
      { role: "user", content: "first user" },
      { role: "assistant", content: "first assistant" },
      { role: "user", content: "middle user" },
      { role: "assistant", content: "middle assistant" },
      { role: "user", content: "latest user" },
      {
        role: "assistant",
        content: "latest assistant",
        copilot_cache_control: cacheControl,
      },
    ])
  })

  test("direct Chat Completions does not guess Gemini eligibility without model metadata", async () => {
    const response = await post("/v1/chat/completions", {
      model: "gemini-unlisted",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "latest" },
      ],
    })

    expect(response.status).toBe(200)
    expect(upstreamPayload().messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "latest" },
    ])
  })

  test("Messages uses legacy selection when Gemini-like model metadata is missing", async () => {
    const response = await post("/v1/messages", {
      model: "gemini-unlisted",
      max_tokens: 64,
      system: "system prompt",
      messages: geminiConversation,
    })

    expect(response.status).toBe(200)
    expect(upstreamPayload().messages).toEqual([
      {
        role: "system",
        content: "system prompt",
        copilot_cache_control: cacheControl,
      },
      { role: "user", content: "first user" },
      { role: "assistant", content: "first assistant" },
      { role: "user", content: "middle user" },
      { role: "assistant", content: "middle assistant" },
      { role: "user", content: "latest user" },
      {
        role: "assistant",
        content: "latest assistant",
        copilot_cache_control: cacheControl,
      },
    ])
  })

  test("direct Chat Completions does not use a Gemini-like id with non-Gemini family metadata", async () => {
    const model = "gemini-like-with-gpt-family"
    state.models?.data.push(createModel(model, "gpt"))
    const messages: ChatCompletionsPayload["messages"] = [
      { role: "system", content: "system prompt" },
      ...geminiConversation,
    ]

    const response = await post("/v1/chat/completions", { model, messages })

    expect(response.status).toBe(200)
    expect(upstreamPayload().messages).toEqual(messages)
  })
})
