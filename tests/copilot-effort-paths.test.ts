// 默认 handler 与 service 经本地 HTTP/WS 上游验证 effort 默认值与请求优先级。
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import consola from "consola"
import { Hono } from "hono"

import { invalidateAutoSession } from "~/lib/auto-session"
import { invalidateConfigCache, reloadConfig } from "~/lib/config-store"
import { shutdownLoggerRuntime } from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"
import { closeUsageStore } from "~/lib/token-usage"
import { traceIdMiddleware } from "~/lib/trace"
import type { Model, ModelsResponse } from "~/lib/types/models"
import { responsesRoutes } from "~/routes/responses/route"
import { messageRoutes } from "~/routes/messages/route"

const NATIVE_MODEL = "local-effort-native"
const CHAT_MODEL = "local-effort-chat"
const MESSAGES_MODEL = "local-effort-messages"
const MESSAGES_STATIC_MODEL = "local-effort-messages-static"
const WEBSOCKET_MODEL = "local-effort-websocket"
const TEST_TOKEN = "local-effort-test-token"
const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const LOG_DIR_ENV = "COPILOT_API_LOG_DIR"
const PROXY_ENV_KEYS = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "npm_config_http_proxy",
  "NPM_CONFIG_HTTP_PROXY",
  "npm_config_https_proxy",
  "NPM_CONFIG_HTTPS_PROXY",
  "npm_config_proxy",
  "NPM_CONFIG_PROXY",
  "all_proxy",
  "ALL_PROXY",
] as const

interface RecordedUpstreamRequest {
  path: string
  headers: Record<string, string>
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
  verbose: state.verbose,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  vsCodeVersion: state.vsCodeVersion,
}
const originalEnv = {
  [DB_PATH_ENV]: process.env[DB_PATH_ENV],
  [LOG_DIR_ENV]: process.env[LOG_DIR_ENV],
}
const originalConfigPath = PATHS.CONFIG_PATH
const originalProxyEnv = new Map(
  PROXY_ENV_KEYS.map((key) => [key, process.env[key]] as const),
)

// 配置只写进临时目录：模型 effort 默认值来自这里，而不是用户磁盘配置。
const testConfig = {
  modelReasoningEfforts: {
    [NATIVE_MODEL]: "low",
    [CHAT_MODEL]: "medium",
    [MESSAGES_MODEL]: "medium",
    [MESSAGES_STATIC_MODEL]: "high",
    [WEBSOCKET_MODEL]: "low",
  },
  // 池空闲关闭阈值调小，测试才能在 socket 归还后观察到关闭而非等默认 60s。
  upstreamTransport: { websocketPoolIdleTimeoutMs: 25 },
}

const upstreamRequests: Array<RecordedUpstreamRequest> = []
const websocketPayloads: Array<Record<string, unknown>> = []
let respondToResponses:
  ((request: RecordedUpstreamRequest) => Response | Promise<Response>) | null =
  null
let websocketClosedCount = 0
let websocketClosed = Promise.withResolvers<void>()

const responsesResult = (model: string) => ({
  id: "resp_local_effort",
  object: "response",
  created_at: 1_700_000_000,
  model,
  output: [],
  output_text: "",
  status: "completed",
  copilot_usage: null,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
  },
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: false,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
})

const chatCompletionResult = (model: string) => ({
  choices: [
    {
      finish_reason: "stop",
      index: 0,
      logprobs: null,
      message: { content: "hi", role: "assistant" },
    },
  ],
  created: 0,
  id: "chatcmpl_local_effort",
  model,
  object: "chat.completion",
  usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
})

const messagesResult = (model: string) => ({
  content: [{ text: "hi", type: "text" }],
  id: "msg_local_effort",
  model,
  role: "assistant",
  stop_reason: "end_turn",
  stop_sequence: null,
  type: "message",
  usage: { input_tokens: 1, output_tokens: 1 },
})

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, bunServer) {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (bunServer.upgrade(request)) return
      return new Response("upgrade failed", { status: 500 })
    }

    const url = new URL(request.url)
    const recorded: RecordedUpstreamRequest = {
      path: url.pathname,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    }
    upstreamRequests.push(recorded)
    const parsed = JSON.parse(recorded.body || "{}") as { model?: string }
    const model = typeof parsed.model === "string" ? parsed.model : "unknown"

    if (recorded.path === "/responses") {
      return respondToResponses ?
          await respondToResponses(recorded)
        : Response.json(responsesResult(model))
    }
    if (recorded.path === "/chat/completions") {
      return Response.json(chatCompletionResult(model))
    }
    if (recorded.path === "/v1/messages") {
      return Response.json(messagesResult(model))
    }

    return new Response("not found", { status: 404 })
  },
  websocket: {
    message(ws, data) {
      const payload = JSON.parse(String(data)) as Record<string, unknown>
      websocketPayloads.push(payload)
      ws.send(
        JSON.stringify({
          type: "response.completed",
          sequence_number: 1,
          response: responsesResult(
            typeof payload.model === "string" ? payload.model : "unknown",
          ),
        }),
      )
    },
    close() {
      websocketClosedCount += 1
      websocketClosed.resolve()
    },
  },
})
const serverUrl = `http://127.0.0.1:${server.port}`

const app = new Hono()
app.use(traceIdMiddleware)
app.route("/v1/responses", responsesRoutes)
app.route("/v1/messages", messageRoutes)

let tempDir: string
let dbCounter = 0

const postResponses = (
  payload: unknown,
  headers: Record<string, string> = {},
) =>
  app.request("/v1/responses", {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  })

const upstreamFor = (pathname: string): Array<RecordedUpstreamRequest> =>
  upstreamRequests.filter((request) => request.path === pathname)

const requestJsonBody = (
  request: RecordedUpstreamRequest,
): Record<string, unknown> =>
  JSON.parse(request.body) as Record<string, unknown>

const reasoningEffortOf = (body: Record<string, unknown>): string | undefined =>
  (body.reasoning as { effort?: string } | undefined)?.effort

const withInfoLogs = async (
  run: () => Response | Promise<Response>,
): Promise<{ logs: Array<string>; response: Response }> => {
  const info = spyOn(consola, "info")
  try {
    const response = await run()
    return { logs: info.mock.calls.map((args) => String(args[0])), response }
  } finally {
    info.mockRestore()
  }
}

const reasoningInputItem = (
  body: Record<string, unknown>,
): Record<string, unknown> => {
  const input = body.input as Array<Record<string, unknown>>
  return input.find((item) => item.type === "reasoning") ?? {}
}

const createModel = (
  id: string,
  supportedEndpoints: Array<string>,
  supports: Model["capabilities"]["supports"],
): Model => ({
  capabilities: {
    family: "test",
    limits: { max_prompt_tokens: 128_000 },
    object: "model_capabilities",
    supports,
    tokenizer: "test",
    type: "chat.completions",
  },
  id,
  model_picker_enabled: true,
  name: id,
  object: "model",
  preview: false,
  supported_endpoints: supportedEndpoints,
  vendor: "test",
  version: "1",
})

const createModels = (): ModelsResponse => ({
  object: "list",
  data: [
    createModel(NATIVE_MODEL, ["/responses"], {
      reasoning_effort: ["low", "medium", "high"],
    }),
    createModel(CHAT_MODEL, ["/chat/completions"], {
      reasoning_effort: ["low", "medium", "high"],
    }),
    createModel(MESSAGES_MODEL, ["/v1/messages"], {
      adaptive_thinking: true,
      reasoning_effort: ["low", "medium", "high", "max"],
    }),
    createModel(MESSAGES_STATIC_MODEL, ["/v1/messages"], {
      adaptive_thinking: false,
      reasoning_effort: ["low", "high"],
    }),
    createModel(WEBSOCKET_MODEL, ["/responses", "ws:/responses"], {
      reasoning_effort: ["low", "medium", "high"],
    }),
  ],
})

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-effort-paths-"))
  for (const key of PROXY_ENV_KEYS) Reflect.deleteProperty(process.env, key)
})

beforeEach(async () => {
  process.env[DB_PATH_ENV] = path.join(tempDir, `usage-${++dbCounter}.sqlite`)
  process.env[LOG_DIR_ENV] = path.join(tempDir, "logs")
  await closeUsageStore()

  PATHS.CONFIG_PATH = path.join(tempDir, "config.json")
  await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify(testConfig))
  reloadConfig()

  state.copilotToken = TEST_TOKEN
  state.copilotApiUrl = serverUrl
  state.copilotTelemetryEnabled = false
  state.forceAgent = false
  state.accountType = "individual"
  state.verbose = false
  state.macMachineId = "machine-local"
  state.vsCodeDeviceId = "device-local"
  state.vsCodeSessionId = "session-local"
  state.vsCodeVersion = "1.120.0"
  state.models = createModels()
  state.responsesReplayLearned.clear()

  upstreamRequests.length = 0
  websocketPayloads.length = 0
  websocketClosedCount = 0
  websocketClosed = Promise.withResolvers<void>()
  respondToResponses = null
})

afterEach(async () => {
  await closeUsageStore()
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }

  state.accountType = originalState.accountType
  state.copilotApiUrl = originalState.copilotApiUrl
  state.copilotTelemetryEnabled = originalState.copilotTelemetryEnabled
  state.copilotToken = originalState.copilotToken
  state.forceAgent = originalState.forceAgent
  state.macMachineId = originalState.macMachineId
  state.models = originalState.models
  state.verbose = originalState.verbose
  state.vsCodeDeviceId = originalState.vsCodeDeviceId
  state.vsCodeSessionId = originalState.vsCodeSessionId
  state.vsCodeVersion = originalState.vsCodeVersion
  state.responsesReplayLearned.clear()
  invalidateAutoSession()

  upstreamRequests.length = 0
  websocketPayloads.length = 0
  respondToResponses = null
})

afterAll(async () => {
  PATHS.CONFIG_PATH = originalConfigPath
  invalidateConfigCache()

  await server.stop(true)
  shutdownLoggerRuntime()
  await closeUsageStore()
  for (const [key, value] of originalProxyEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe("Messages 到 Chat 的显式 effort 优先级", () => {
  test("能力数据缺失时，显式 low 不会被配置 medium 覆盖", async () => {
    const model = state.models!.data.find((item) => item.id === CHAT_MODEL)!
    delete model.capabilities.supports.reasoning_effort
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: CHAT_MODEL,
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
        output_config: { effort: "low" },
      }),
    })
    expect(response.status).toBe(200)
    expect(
      requestJsonBody(upstreamFor("/chat/completions")[0]).reasoning_effort,
    ).toBe("low")
  })
})

describe("native Responses effort", () => {
  const nativeModel = () =>
    state.models!.data.find((item) => item.id === NATIVE_MODEL)!

  test("请求未给 effort 时把模型配置的默认值发往上游", async () => {
    const { logs, response } = await withInfoLogs(() =>
      postResponses({ input: "hello", model: NATIVE_MODEL }),
    )

    expect(response.status).toBe(200)
    expect(upstreamFor("/responses")).toHaveLength(1)
    expect(
      reasoningEffortOf(requestJsonBody(upstreamFor("/responses")[0])),
    ).toBe("low")
    expect(logs).toContain(`IN ${NATIVE_MODEL} [effort=low (config)]`)
  })

  test("请求显式 effort 时优先于模型配置", async () => {
    const { logs, response } = await withInfoLogs(() =>
      postResponses({
        input: "hello",
        model: NATIVE_MODEL,
        reasoning: { effort: "high" },
      }),
    )

    expect(response.status).toBe(200)
    expect(
      reasoningEffortOf(requestJsonBody(upstreamFor("/responses")[0])),
    ).toBe("high")
    expect(logs).toContain(`IN ${NATIVE_MODEL} [effort=high (request)]`)
  })

  test("能力列表缺失时保留旧配置默认值行为", async () => {
    delete nativeModel().capabilities.supports.reasoning_effort
    const { logs, response } = await withInfoLogs(() =>
      postResponses({ input: "hello", model: NATIVE_MODEL }),
    )

    expect(response.status).toBe(200)
    expect(
      reasoningEffortOf(requestJsonBody(upstreamFor("/responses")[0])),
    ).toBe("low")
    expect(logs).toContain(`IN ${NATIVE_MODEL} [effort=low (config)]`)
  })

  test("空能力列表时不注入 effort", async () => {
    nativeModel().capabilities.supports.reasoning_effort = []
    const { logs, response } = await withInfoLogs(() =>
      postResponses({ input: "hello", model: NATIVE_MODEL }),
    )

    expect(response.status).toBe(200)
    expect(
      requestJsonBody(upstreamFor("/responses")[0]).reasoning,
    ).toBeUndefined()
    expect(logs).toContain(`IN ${NATIVE_MODEL} [effort=unsupported (config)]`)
  })

  test("非空能力列表把配置默认值向下收敛后发往上游", async () => {
    nativeModel().capabilities.supports.reasoning_effort = ["minimal"]
    const { logs, response } = await withInfoLogs(() =>
      postResponses({ input: "hello", model: NATIVE_MODEL }),
    )

    expect(response.status).toBe(200)
    expect(
      reasoningEffortOf(requestJsonBody(upstreamFor("/responses")[0])),
    ).toBe("minimal")
    expect(logs).toContain(`IN ${NATIVE_MODEL} [effort=minimal (config)]`)
  })

  test("补配置默认值时保留 summary", async () => {
    const { response } = await withInfoLogs(() =>
      postResponses({
        input: "hello",
        model: NATIVE_MODEL,
        reasoning: { summary: "concise" },
      }),
    )

    expect(response.status).toBe(200)
    expect(requestJsonBody(upstreamFor("/responses")[0]).reasoning).toEqual({
      effort: "low",
      summary: "concise",
    })
  })
})

describe("Responses 到 Chat Completions 回退的 effort", () => {
  test("请求未给 effort 时把模型配置的默认值发往上游", async () => {
    const response = await postResponses({ input: "hello", model: CHAT_MODEL })

    expect(response.status).toBe(200)
    const upstream = upstreamFor("/chat/completions")[0]
    expect(upstream.path).toBe("/chat/completions")
    const body = requestJsonBody(upstream)
    expect(body.model).toBe(CHAT_MODEL)
    expect(body.reasoning_effort).toBe("medium")
  })

  test("请求显式 effort 时优先于模型配置", async () => {
    const response = await postResponses({
      input: "hello",
      model: CHAT_MODEL,
      reasoning: { effort: "low" },
    })

    expect(response.status).toBe(200)
    expect(
      requestJsonBody(upstreamFor("/chat/completions")[0]).reasoning_effort,
    ).toBe("low")
  })
})

describe("Responses 到 Messages 回退的 effort", () => {
  test("自适应模型缺省 effort 时补配置默认值并启用自适应思考", async () => {
    const response = await postResponses({
      input: "hello",
      model: MESSAGES_MODEL,
    })

    expect(response.status).toBe(200)
    const body = requestJsonBody(upstreamFor("/v1/messages")[0])
    expect(body.thinking).toEqual({ type: "adaptive" })
    expect(body.output_config).toEqual({ effort: "medium" })
  })

  test("自适应模型保留请求显式 effort", async () => {
    const response = await postResponses({
      input: "hello",
      model: MESSAGES_MODEL,
      reasoning: { effort: "high" },
    })

    expect(response.status).toBe(200)
    expect(
      requestJsonBody(upstreamFor("/v1/messages")[0]).output_config,
    ).toEqual({ effort: "high" })
  })

  test("强制工具把 tool_choice 转成 any 后不补默认 effort 也不开思考", async () => {
    const response = await postResponses({
      input: "hello",
      model: MESSAGES_MODEL,
      tool_choice: "required",
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: { type: "object", properties: {} },
        },
      ],
    })

    expect(response.status).toBe(200)
    const body = requestJsonBody(upstreamFor("/v1/messages")[0])
    const tools = body.tools as Array<{ name?: string }>
    expect(tools.map((tool) => tool.name)).toEqual(["lookup"])
    expect(body.tool_choice).toEqual({ type: "any" })
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toBeUndefined()
  })

  test("非自适应模型缺省 effort 时不补默认值", async () => {
    const response = await postResponses({
      input: "hello",
      model: MESSAGES_STATIC_MODEL,
    })

    expect(response.status).toBe(200)
    const body = requestJsonBody(upstreamFor("/v1/messages")[0])
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toBeUndefined()
  })

  test("非自适应模型保留请求显式 effort", async () => {
    const response = await postResponses({
      input: "hello",
      model: MESSAGES_STATIC_MODEL,
      reasoning: { effort: "low" },
    })

    expect(response.status).toBe(200)
    const body = requestJsonBody(upstreamFor("/v1/messages")[0])
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toEqual({ effort: "low" })
  })
})

describe("native Responses WebSocket effort", () => {
  test("缺省 effort 随 response.create 发送，连接归还池后关闭", async () => {
    const response = await postResponses(
      { input: "hello", model: WEBSOCKET_MODEL, stream: true },
      { "x-session-affinity": "ws-default" },
    )
    expect(await response.text()).toContain("response.completed")

    expect(websocketPayloads).toHaveLength(1)
    const payload = websocketPayloads[0]
    expect(payload.type).toBe("response.create")
    expect(payload.model).toBe(WEBSOCKET_MODEL)
    expect(reasoningEffortOf(payload)).toBe("low")

    await websocketClosed.promise
    expect(websocketClosedCount).toBe(1)
  })

  test("请求显式 effort 时优先于模型配置", async () => {
    const response = await postResponses(
      {
        input: "hello",
        model: WEBSOCKET_MODEL,
        reasoning: { effort: "high" },
        stream: true,
      },
      { "x-session-affinity": "ws-explicit" },
    )
    await response.text()

    expect(reasoningEffortOf(websocketPayloads[0])).toBe("high")

    await websocketClosed.promise
    expect(websocketClosedCount).toBe(1)
  })
})

describe("belong 重放学习按显式会话身份生效", () => {
  test("学习后首发即移除 encrypted_content，其他身份不受影响", async () => {
    let upstreamCalls = 0
    respondToResponses = () => {
      upstreamCalls += 1
      if (upstreamCalls === 1) {
        return Response.json(
          {
            error: {
              message: "Item rs_local does not belong to this instance",
            },
          },
          { status: 400 },
        )
      }
      return Response.json(responsesResult(NATIVE_MODEL))
    }

    const reasoningInput = () => [
      {
        type: "reasoning",
        id: "rs_local",
        encrypted_content: "enc_local",
        summary: [{ type: "summary_text", text: "done" }],
      },
      { role: "user", content: "hello" },
    ]
    const session = { "session-id": "replay-session", "x-oc-agent": "codex" }
    const postReasoning = (headers: Record<string, string> = {}) =>
      postResponses({ input: reasoningInput(), model: NATIVE_MODEL }, headers)

    expect((await postReasoning(session)).status).toBe(200)
    expect((await postReasoning(session)).status).toBe(200)
    expect(
      (
        await postReasoning({
          "session-id": "other-session",
          "x-oc-agent": "codex",
        })
      ).status,
    ).toBe(200)
    expect((await postReasoning()).status).toBe(200)

    const sent = upstreamFor("/responses").map(requestJsonBody)
    expect(sent).toHaveLength(5)
    // 首次携带 encrypted_content 被上游拒绝，重试时移除该字段
    expect(reasoningInputItem(sent[0]).encrypted_content).toBe("enc_local")
    expect(reasoningInputItem(sent[1])).toEqual({
      id: "rs_local",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "done" }],
    })
    // 同一身份的下一次请求首发即已移除
    expect(reasoningInputItem(sent[2]).encrypted_content).toBeUndefined()
    // 其他会话身份与无身份请求保持原样
    expect(reasoningInputItem(sent[3]).encrypted_content).toBe("enc_local")
    expect(reasoningInputItem(sent[4]).encrypted_content).toBe("enc_local")
  })
})
