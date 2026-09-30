// 默认 handler 与 service 通过本地 HTTP 验证协议、用量和取消行为。
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import {
  events as sseEvents,
  type ServerSentEventMessage,
} from "fetch-event-stream"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Hono } from "hono"

import { invalidateAutoSession } from "~/lib/auto-session"
import { shutdownLoggerRuntime } from "~/lib/logger"
import { state } from "~/lib/state"
import { closeUsageStore, getTokenUsageEventsPage } from "~/lib/token-usage"
import type { ResponsesResult } from "~/lib/types/responses"
import { getUUID } from "~/lib/utils"
import { responsesRoutes } from "~/routes/responses/route"

const MODEL = "local-responses-test"
const SESSION_ID = "local-test-session"
const TEST_TOKEN = "local-http-test-token"
const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const LOG_DIR_ENV = "COPILOT_API_LOG_DIR"
const QUOTA_HEADER = "x-quota-snapshot-premium_interactions"
const QUOTA_VALUE = "ent=100&rem=42"
const CUSTOM_HEADER = "x-upstream-custom"
const CUSTOM_VALUE = "yes-please"
const IMAGE_DATA_URL = `data:image/png;base64,${"QUJDREVG".repeat(32)}`

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

const upstreamRequests: Array<RecordedUpstreamRequest> = []
let respondToResponses:
  ((request: RecordedUpstreamRequest) => Response | Promise<Response>) | null =
  null

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const recorded: RecordedUpstreamRequest = {
      path: url.pathname,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    }
    upstreamRequests.push(recorded)

    if (recorded.path === "/models/session") {
      return Response.json({
        available_models: ["unrelated-model"],
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        session_token: "unused-session-token",
      })
    }

    if (recorded.path === "/responses") {
      if (!respondToResponses) {
        return new Response("upstream responder not installed", { status: 500 })
      }
      return await respondToResponses(recorded)
    }

    return new Response("not found", { status: 404 })
  },
})
const serverUrl = `http://127.0.0.1:${server.port}`

const app = new Hono()
app.route("/v1/responses", responsesRoutes)

let tempDir: string
let dbCounter = 0

const responsesRequests = (): Array<RecordedUpstreamRequest> =>
  upstreamRequests.filter((request) => request.path === "/responses")

const responsesCount = (): number => responsesRequests().length

const requestJsonBody = (
  request: RecordedUpstreamRequest,
): Record<string, unknown> =>
  JSON.parse(request.body) as Record<string, unknown>

const postResponses = (payload: unknown, init: { signal?: AbortSignal } = {}) =>
  app.request("/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "session-id": SESSION_ID,
    },
    body: JSON.stringify(payload),
    ...(init.signal ? { signal: init.signal } : {}),
  })

const createResult = (
  overrides: Partial<ResponsesResult> = {},
): ResponsesResult => ({
  id: "resp_local_http",
  object: "response",
  created_at: 1_700_000_000,
  model: MODEL,
  output: [],
  output_text: "",
  status: "completed",
  copilot_usage: null,
  usage: null,
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: false,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  ...overrides,
})

const sseEvent = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const textPayload = (overrides: Record<string, unknown> = {}) => ({
  model: MODEL,
  input: "hello from local http test",
  ...overrides,
})

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "responses-local-http-"))
})

beforeEach(async () => {
  process.env[DB_PATH_ENV] = path.join(tempDir, `usage-${++dbCounter}.sqlite`)
  process.env[LOG_DIR_ENV] = path.join(tempDir, "logs")
  await closeUsageStore()

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
  state.models = {
    object: "list",
    data: [
      {
        capabilities: { limits: { max_prompt_tokens: 128000 } },
        id: MODEL,
        supported_endpoints: ["/responses"],
      },
    ],
  } as typeof state.models

  upstreamRequests.length = 0
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
  invalidateAutoSession()

  upstreamRequests.length = 0
  respondToResponses = null
})

afterAll(async () => {
  await server.stop(true)
  shutdownLoggerRuntime()
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe("native JSON 响应", () => {
  test("透传 body 与转发 headers，记录 usage，缺省 effort 走默认值", async () => {
    respondToResponses = () =>
      Response.json(
        createResult({
          copilot_usage: { total_nano_aiu: 1234 },
          usage: {
            input_tokens: 4,
            input_tokens_details: { cached_tokens: 1 },
            output_tokens: 2,
            total_tokens: 6,
          },
        }),
        {
          status: 200,
          headers: {
            [QUOTA_HEADER]: QUOTA_VALUE,
            [CUSTOM_HEADER]: CUSTOM_VALUE,
          },
        },
      )

    const response = await postResponses(textPayload())

    expect(response.status).toBe(200)
    expect(response.headers.get(CUSTOM_HEADER)).toBe(CUSTOM_VALUE)
    expect(response.headers.get(QUOTA_HEADER)).toBe(QUOTA_VALUE)
    expect(response.headers.get("content-type")).toContain("application/json")

    const body = (await response.json()) as ResponsesResult
    expect(body.id).toBe("resp_local_http")
    expect(body.model).toBe(MODEL)
    expect(body.status).toBe("completed")
    expect(body.usage?.total_tokens).toBe(6)

    expect(responsesCount()).toBe(1)
    const upstream = responsesRequests()[0]
    expect(upstream.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`)
    expect(upstream.headers["x-interaction-id"]).toBe(getUUID(SESSION_ID))
    expect(upstream.headers["x-request-id"]).toBeTruthy()

    const upstreamBody = requestJsonBody(upstream)
    expect(upstreamBody.model).toBe(MODEL)
    // 原生默认 effort：客户端未给 reasoning.effort 时按模型配置补默认值
    const reasoning = upstreamBody.reasoning as { effort?: string }
    expect(typeof reasoning.effort).toBe("string")
    expect(reasoning.effort?.length).toBeGreaterThan(0)

    // 非流式：app.request 返回即 handler 已执行 recordUsage
    await closeUsageStore()
    const page = await getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "today",
    })
    expect(page.total).toBe(1)
    const event = page.items[0]
    expect(event.endpoint).toBe("responses")
    expect(event.model).toBe(MODEL)
    expect(event.session_id).toBe(getUUID(SESSION_ID))
    expect(event.input_tokens).toBe(3)
    expect(event.output_tokens).toBe(2)
    expect(event.cache_read_input_tokens).toBe(1)
    expect(event.total_tokens).toBe(6)
    expect(event.total_nano_aiu).toBe(1234)
  })
})

describe("native SSE 流", () => {
  test("透传事件序列、修复终态 item id、正常结束并记录 usage", async () => {
    const addedItem = {
      content: [],
      id: "item_added_0",
      role: "assistant",
      status: "in_progress",
      type: "message",
    }
    respondToResponses = () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              sseEvent("response.created", {
                response: createResult({ status: "in_progress" }),
                sequence_number: 0,
                type: "response.created",
              }),
            ),
          )
          controller.enqueue(
            encoder.encode(
              sseEvent("response.output_item.added", {
                item: addedItem,
                output_index: 0,
                sequence_number: 1,
                type: "response.output_item.added",
              }),
            ),
          )
          controller.enqueue(
            encoder.encode(
              sseEvent("response.output_text.delta", {
                content_index: 0,
                delta: "Hi",
                item_id: "item_stale_x",
                output_index: 0,
                sequence_number: 2,
                type: "response.output_text.delta",
              }),
            ),
          )
          controller.enqueue(
            encoder.encode(
              sseEvent("response.output_item.done", {
                item: {
                  ...addedItem,
                  id: "item_done_differs",
                  status: "completed",
                },
                output_index: 0,
                sequence_number: 3,
                type: "response.output_item.done",
              }),
            ),
          )
          controller.enqueue(
            encoder.encode(
              sseEvent("response.completed", {
                copilot_usage: { total_nano_aiu: 777 },
                response: createResult({
                  usage: {
                    input_tokens: 10,
                    input_tokens_details: { cached_tokens: 3 },
                    output_tokens: 4,
                    total_tokens: 14,
                  },
                }),
                sequence_number: 4,
                type: "response.completed",
              }),
            ),
          )
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          [QUOTA_HEADER]: QUOTA_VALUE,
          [CUSTOM_HEADER]: CUSTOM_VALUE,
        },
      })
    }

    const response = await postResponses(textPayload({ stream: true }))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(response.headers.get(CUSTOM_HEADER)).toBe(CUSTOM_VALUE)
    expect(response.headers.get(QUOTA_HEADER)).toBe(QUOTA_VALUE)

    const events: Array<ServerSentEventMessage> = []
    for await (const event of sseEvents(response)) events.push(event)
    expect(events.map((entry) => entry.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ])

    const delta = JSON.parse(events[2].data ?? "") as { item_id: string }
    expect(delta.item_id).toBe("item_added_0")

    const done = JSON.parse(events[3].data ?? "") as { item: { id: string } }
    expect(done.item.id).toBe("item_added_0")

    const completed = JSON.parse(events[4].data ?? "") as {
      response: { usage?: { total_tokens?: number } }
    }
    expect(completed.response.usage?.total_tokens).toBe(14)

    expect(responsesCount()).toBe(1)

    await closeUsageStore()
    const page = await getTokenUsageEventsPage({
      page: 1,
      pageSize: 10,
      period: "today",
    })
    expect(page.total).toBe(1)
    const event = page.items[0]
    expect(event.endpoint).toBe("responses")
    expect(event.model).toBe(MODEL)
    expect(event.input_tokens).toBe(7)
    expect(event.output_tokens).toBe(4)
    expect(event.cache_read_input_tokens).toBe(3)
    expect(event.total_tokens).toBe(14)
    expect(event.total_nano_aiu).toBe(777)
  })
})

describe("413 重试", () => {
  const tooLargeUpstream = () =>
    Response.json(
      {
        error: {
          message: "request entity too large",
          type: "request_too_large",
        },
      },
      { status: 413 },
    )

  test("有图时仅重试一次且 vision/reasoning/session/请求头保持", async () => {
    let attempt = 0
    respondToResponses = () => {
      attempt += 1
      return attempt === 1 ? tooLargeUpstream() : (
          Response.json(createResult({ id: "resp_after_retry" }), {
            status: 200,
            headers: {
              [QUOTA_HEADER]: QUOTA_VALUE,
              [CUSTOM_HEADER]: CUSTOM_VALUE,
            },
          })
        )
    }

    const response = await postResponses({
      model: MODEL,
      reasoning: { effort: "high" },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe this image" },
            { type: "input_image", image_url: IMAGE_DATA_URL },
          ],
        },
      ],
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as ResponsesResult
    expect(body.id).toBe("resp_after_retry")

    const requests = responsesRequests()
    expect(requests).toHaveLength(2)
    const [first, second] = requests as [
      RecordedUpstreamRequest,
      RecordedUpstreamRequest,
    ]

    const firstBody = requestJsonBody(first)
    const secondBody = requestJsonBody(second)
    expect(firstBody.model).toBe(MODEL)
    expect(secondBody.model).toBe(MODEL)
    expect(firstBody.reasoning).toEqual({ effort: "high" })
    expect(secondBody.reasoning).toEqual({ effort: "high" })

    const firstInput = firstBody.input as Array<{
      content: Array<Record<string, unknown>>
    }>
    const secondInput = secondBody.input as Array<{
      content: Array<Record<string, unknown>>
    }>
    expect(firstInput[0].content[1]).toEqual({
      image_url: IMAGE_DATA_URL,
      type: "input_image",
    })
    const secondImage = secondInput[0].content[1]
    expect(secondImage.type).toBe("input_image")
    expect(String(secondImage.image_url)).toMatch(/^data:image\/png;base64,/)
    expect(String(secondImage.image_url)).not.toContain("QUJDREVG")
    expect(secondImage.detail).toBe("low")

    const preservedHeaders = [
      "authorization",
      "x-interaction-id",
      "x-request-id",
      "x-agent-task-id",
      "copilot-vision-request",
    ] as const
    for (const name of preservedHeaders) {
      expect(second.headers[name]).toBe(first.headers[name])
    }
    expect(first.headers["copilot-vision-request"]).toBe("true")
    expect(first.headers["x-interaction-id"]).toBe(getUUID(SESSION_ID))
  })

  test("无图 413 不重试且错误透传", async () => {
    respondToResponses = () => tooLargeUpstream()

    const response = await postResponses(textPayload())

    expect(response.status).toBe(413)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain("request entity too large")
    expect(responsesCount()).toBe(1)
  })

  test("第二次仍 413 时不再重试", async () => {
    respondToResponses = () => tooLargeUpstream()

    const response = await postResponses({
      model: MODEL,
      reasoning: { effort: "high" },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe this image" },
            { type: "input_image", image_url: IMAGE_DATA_URL },
          ],
        },
      ],
    })

    expect(response.status).toBe(413)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain("request entity too large")
    expect(responsesCount()).toBe(2)
  })
})

describe("取消信号", () => {
  test("预取消直接返回 499 且不触碰上游", async () => {
    const controller = new AbortController()
    controller.abort()

    const response = await postResponses(textPayload(), {
      signal: controller.signal,
    })

    expect(response.status).toBe(499)
    expect(responsesCount()).toBe(0)
    expect(
      upstreamRequests.filter((request) => request.path === "/models/session"),
    ).toHaveLength(0)
  })

  test("发送后取消客户端信号仍完整读取上游并记录用量", async () => {
    const started =
      Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    let upstreamCancelled = false
    let upstreamClosed = false
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            sseEvent("response.created", {
              response: createResult({ status: "in_progress" }),
              sequence_number: 0,
              type: "response.created",
            }),
          ),
        )
        started.resolve(controller)
      },
      cancel() {
        upstreamCancelled = true
      },
    })
    const upstreamController = await started.promise
    respondToResponses = () =>
      new Response(upstreamBody, {
        headers: {
          "content-type": "text/event-stream",
          [QUOTA_HEADER]: QUOTA_VALUE,
        },
      })
    const abort = new AbortController()
    try {
      const response = await postResponses(textPayload({ stream: true }), {
        signal: abort.signal,
      })
      expect(response.status).toBe(200)
      const stream = sseEvents(response)
      expect((await stream.next()).value?.event).toBe("response.created")

      abort.abort()
      upstreamController.enqueue(
        new TextEncoder().encode(
          sseEvent("response.completed", {
            type: "response.completed",
            sequence_number: 1,
            response: createResult({
              usage: {
                input_tokens: 4,
                output_tokens: 2,
                total_tokens: 6,
              },
            }),
          }),
        ),
      )
      upstreamController.close()
      upstreamClosed = true

      const trailingEvents: Array<string | undefined> = []
      for await (const event of stream) trailingEvents.push(event.event)
      expect(trailingEvents).toEqual(["response.completed"])
      expect(upstreamCancelled).toBe(false)
      expect(responsesCount()).toBe(1)

      await closeUsageStore()
      const page = await getTokenUsageEventsPage({
        page: 1,
        pageSize: 10,
        period: "today",
      })
      expect(page.total).toBe(1)
      expect(page.items[0]).toMatchObject({
        endpoint: "responses",
        model: MODEL,
        session_id: getUUID(SESSION_ID),
        input_tokens: 4,
        output_tokens: 2,
        total_tokens: 6,
      })
    } finally {
      abort.abort()
      if (!upstreamClosed && !upstreamCancelled) upstreamController.close()
    }
  })
})
