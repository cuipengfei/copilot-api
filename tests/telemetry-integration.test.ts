import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test"
import { consola } from "consola"
import type { ServerSentEventMessage } from "fetch-event-stream"

let mockTelemetryEnabled: boolean | undefined = false

// Complete config shape to prevent cross-test contamination (see telemetry.test.ts)
const codexToolPrompt = `
## Tool use
- You have access to many tools. If a tool exists to perform a specific task, you MUST use that tool instead of running a terminal command to perform that task.
### Bash tool
When using the Bash tool, follow these rules:
- always run_in_background set to false, unless you are running a long-running command (e.g., a server or a watch command).
### BashOutput tool
When using the BashOutput tool, follow these rules:
- Only Bash Tool run_in_background set to true, Use BashOutput to read the output later
### TodoWrite tool
When using the TodoWrite tool, follow these rules:
- Skip using the TodoWrite tool for tasks with three or fewer steps.
- Do not make single-step todo lists.
- When you made a todo, update it after having performed one of the sub-tasks that you shared on the todo list.
## Special user requests
- If the user makes a simple request (such as asking for the time) which you can fulfill by running a terminal command (such as 'date'), you should do so.
`

function getMockConfig(): {
  telemetry: boolean | undefined
  extraPrompts: Record<string, string>
  smallModel: string
  modelReasoningEfforts: Record<string, string>
  compactUseSmallModel: boolean
} {
  return {
    telemetry: mockTelemetryEnabled,
    extraPrompts: {
      "gpt-5-codex": codexToolPrompt,
      "gpt-5.4": "## Intermediary updates",
    },
    smallModel: "gpt-5-mini",
    modelReasoningEfforts: { "gpt-5-mini": "low" },
    compactUseSmallModel: true,
  }
}

void mock.module("~/lib/config", () => ({
  getConfig: getMockConfig,
  getExtraPromptForModel: (model: string): string =>
    getMockConfig().extraPrompts[model] ?? "",
  getSmallModel: (): string => getMockConfig().smallModel,
  getReasoningEffortForModel: (model: string): string =>
    getMockConfig().modelReasoningEfforts[model] ?? "high",
  shouldCompactUseSmallModel: (): boolean =>
    getMockConfig().compactUseSmallModel,
  mergeConfigWithDefaults: getMockConfig,
}))

import { HTTPError } from "~/lib/http/error"
import { state } from "~/lib/state"
import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import { createResponses } from "~/services/copilot/create-responses"
import { clearTelemetryConversations } from "~/services/telemetry/mock-values"
import type {
  TelemetryEnvelope,
  TelemetryRequestContext,
} from "~/services/telemetry/types"
import {
  initTelemetry,
  trackAuthNewToken,
  trackEvent,
  trackGhostTextShown,
  trackPanelRequest,
} from "~/services/telemetry/telemetry"
import { DEFAULT_TELEMETRY_ENDPOINT } from "~/services/telemetry/types"

const DIRECT_TELEMETRY_ENDPOINT = DEFAULT_TELEMETRY_ENDPOINT

type FetchCall = {
  url: string
  options?: RequestInit
}

let fetchCalls: Array<FetchCall> = []
let originalFetch: typeof globalThis.fetch
let originalRandom: typeof Math.random
let scheduledTimers: Array<{ fn: () => void; delay: number }> = []
let originalSetTimeout: typeof globalThis.setTimeout

const chatResponse = {
  id: "chat-ok",
  object: "chat.completion",
  created: 0,
  model: "gpt-test",
  choices: [],
}

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  const response = new Response(JSON.stringify(payload), init)
  response.headers.set("content-type", "application/json")
  return response
}

function toUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function installFetchMock(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): void {
  const mockFn = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = toUrl(input)
    fetchCalls.push({ url, options: init })

    return handler(url, init)
  })

  globalThis.fetch = mockFn as unknown as typeof fetch
}

function telemetryCalls(): Array<FetchCall> {
  return fetchCalls.filter((x) => x.url === DIRECT_TELEMETRY_ENDPOINT)
}

function parseFirstTelemetryEnvelope(): Record<string, unknown> {
  const call = telemetryCalls().at(0)
  expect(call).toBeDefined()

  const body = call?.options?.body
  expect(typeof body).toBe("string")

  const envelopes = JSON.parse((body ?? "[]") as string) as Array<
    Record<string, unknown>
  >
  const firstEnvelope = envelopes.at(0)
  if (!firstEnvelope) {
    throw new TypeError("telemetry envelope missing")
  }

  return firstEnvelope
}

function telemetryEnvelopes(): Array<TelemetryEnvelope> {
  return telemetryCalls().flatMap(
    (call) =>
      JSON.parse(call.options?.body as string) as Array<TelemetryEnvelope>,
  )
}

function telemetryEvent(
  name: string,
  requestId?: string,
  source?: string,
): TelemetryEnvelope {
  const event = telemetryEnvelopes().find((envelope) => {
    const { name: eventName, properties } = envelope.data.baseData
    return (
      eventName === name
      && (requestId === undefined
        || properties.requestId === requestId
        || properties.headerRequestId === requestId)
      && (source === undefined || properties.source === source)
    )
  })
  if (!event) throw new Error(`Telemetry event missing: ${name}`)
  return event
}

function contextFor(requestId: string, model: string): TelemetryRequestContext {
  return {
    requestId,
    sampled: true,
    conversationId: `conversation-${requestId}`,
    turnIndex: 0,
    issuedAt: Date.now(),
    model,
    languageId: "typescript",
    mode: "ask",
    participant: "github.copilot.default",
    clientCompletionId: `completion-${requestId}`,
    isAgent: 0,
    messageId: `message-${requestId}`,
    totalCharacters: 240,
    totalLines: 12,
    lineCount: 20,
    linesAdded: 7,
    linesRemoved: 3,
    editCount: 2,
    editLineCount: 4,
  }
}

async function flushMicrotasks(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  originalSetTimeout(resolve, 20)
  await promise
}

function buildPayload(): ChatCompletionsPayload {
  return {
    model: "gpt-test",
    messages: [{ role: "user", content: "hello" }],
  }
}

beforeEach(() => {
  fetchCalls = []
  originalFetch = globalThis.fetch
  originalRandom = Math.random
  originalSetTimeout = globalThis.setTimeout
  scheduledTimers = []
  globalThis.setTimeout = ((fn: () => void, delay?: number) => {
    if (typeof fn !== "function")
      throw new TypeError("Timer callback must be a function")
    scheduledTimers.push({ fn, delay: delay ?? 0 })
    return 0 as never
  }) as unknown as typeof globalThis.setTimeout
  Math.random = () => 0.1 // Always pass the 30% sampling gate in trackEvent
  mockTelemetryEnabled = false

  state.copilotToken = "test-copilot-token"
  state.copilotApiUrl = undefined
  state.copilotTrackingId = undefined
  state.copilotTelemetryEnabled = undefined
  state.githubToken = "test-github-token"
  state.vsCodeVersion = "1.0.0"
  state.vsCodeSessionId = "editor-integration"
  clearTelemetryConversations()
  state.accountType = "individual"
  state.organizationList = undefined
  state.enterpriseList = undefined
  state.forceAgent = false

  initTelemetry("tid=test-user;exp=9999999999;sku=test_sku")
})

afterEach(() => {
  mockTelemetryEnabled = false
  globalThis.fetch = originalFetch
  Math.random = originalRandom
  globalThis.setTimeout = originalSetTimeout
  scheduledTimers = []
  mock.restore()
})

describe("telemetry integration config gating", () => {
  it("triggers telemetry fetch when config telemetry=true", async () => {
    mockTelemetryEnabled = true
    installFetchMock((url) => {
      if (url === DIRECT_TELEMETRY_ENDPOINT) {
        return Promise.resolve(
          jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
        )
      }
      if (url.includes("/chat/completions")) {
        return Promise.resolve(jsonResponse(chatResponse))
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })

    const result = await createChatCompletions(buildPayload())
    await flushMicrotasks()

    expect(result).toMatchObject({ id: "chat-ok" })
    expect(fetchCalls.some((x) => x.url.includes("/chat/completions"))).toBe(
      true,
    )
    expect(telemetryCalls().length).toBeGreaterThan(0)
  })

  it("sends configured telemetry endpoint without Host override", async () => {
    mockTelemetryEnabled = true
    const endpoint = "https://telemetry.individual.githubcopilot.com"
    initTelemetry("tid=test-user;exp=9999999999;sku=test_sku", endpoint)
    installFetchMock((url) => {
      if (url === `${endpoint}/telemetry`) {
        return Promise.resolve(
          jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
        )
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })

    trackEvent("copilot-chat/request.sent", {})
    await flushMicrotasks()

    const call = fetchCalls.at(0)
    expect(call?.url).toBe(`${endpoint}/telemetry`)
    expect(call?.options?.headers).not.toHaveProperty("host")
  })

  it("does not trigger telemetry fetch when config telemetry=false", async () => {
    mockTelemetryEnabled = false
    installFetchMock((url) => {
      if (url.includes("/chat/completions")) {
        return Promise.resolve(jsonResponse(chatResponse))
      }
      if (url === DIRECT_TELEMETRY_ENDPOINT) {
        return Promise.resolve(
          jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
        )
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })

    const result = await createChatCompletions(buildPayload())
    await flushMicrotasks()

    expect(result).toMatchObject({ id: "chat-ok" })
    expect(telemetryCalls().length).toBe(0)
  })

  it("defaults to disabled when config telemetry is undefined", async () => {
    mockTelemetryEnabled = undefined
    installFetchMock((url) => {
      if (url.includes("/chat/completions")) {
        return Promise.resolve(jsonResponse(chatResponse))
      }
      if (url === DIRECT_TELEMETRY_ENDPOINT) {
        return Promise.resolve(
          jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
        )
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })

    const result = await createChatCompletions(buildPayload())
    await flushMicrotasks()

    expect(result).toMatchObject({ id: "chat-ok" })
    expect(telemetryCalls().length).toBe(0)
  })

  it("still sends standard GH telemetry and records telemetryEnabled=false when server disables telemetry", async () => {
    mockTelemetryEnabled = true
    state.copilotTrackingId = "track-biz-1"
    state.copilotTelemetryEnabled = false
    const bizEndpoint = "https://telemetry.business.githubcopilot.com"
    initTelemetry(
      "tid=biz-user;exp=9999999999;sku=copilot_for_business",
      bizEndpoint,
    )
    installFetchMock((url) => {
      if (url === `${bizEndpoint}/telemetry`) {
        return Promise.resolve(
          jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
        )
      }
      if (url.includes("/chat/completions")) {
        return Promise.resolve(jsonResponse(chatResponse))
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })

    trackAuthNewToken()
    await createChatCompletions(buildPayload())
    await flushMicrotasks()

    const bizCalls = fetchCalls.filter(
      (call) => call.url === `${bizEndpoint}/telemetry`,
    )
    expect(bizCalls.length).toBeGreaterThanOrEqual(2)
    const envelopes = bizCalls.map((call) => {
      const parsed = JSON.parse(call.options?.body as string) as Array<
        Record<string, unknown>
      >
      return parsed[0]
    })
    const authEnv = envelopes.find(
      (env) =>
        (
          (env.data as Record<string, unknown>).baseData as Record<
            string,
            unknown
          >
        ).name === "copilot-chat/auth.new_token",
    )
    expect(authEnv).toBeDefined()
    const authProps = (
      (authEnv?.data as Record<string, unknown>).baseData as Record<
        string,
        unknown
      >
    ).properties as Record<string, string>
    expect(authProps.telemetryEnabled).toBe("false")
  })
})

describe("telemetry integration failure tolerance", () => {
  it("does not block main request when telemetry fetch throws (fire-and-forget)", async () => {
    mockTelemetryEnabled = true
    installFetchMock((url) => {
      if (url === DIRECT_TELEMETRY_ENDPOINT) {
        return Promise.reject(new Error("network error"))
      }
      if (url.includes("/chat/completions")) {
        return Promise.resolve(jsonResponse(chatResponse))
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })

    const result = await createChatCompletions(buildPayload())
    await flushMicrotasks()

    expect(result).toMatchObject({ id: "chat-ok" })
    expect(fetchCalls.some((x) => x.url.includes("/chat/completions"))).toBe(
      true,
    )
  })

  it("does not block main request when telemetry fetch times out", async () => {
    mockTelemetryEnabled = true
    installFetchMock((url) => {
      if (url === DIRECT_TELEMETRY_ENDPOINT) {
        const timeoutError = new Error(
          "The operation was aborted due to timeout",
        )
        timeoutError.name = "TimeoutError"
        return Promise.reject(timeoutError)
      }
      if (url.includes("/chat/completions")) {
        return Promise.resolve(jsonResponse(chatResponse))
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })

    const result = await createChatCompletions(buildPayload())
    await flushMicrotasks()

    expect(result).toMatchObject({ id: "chat-ok" })
    expect(fetchCalls.some((x) => x.url.includes("/chat/completions"))).toBe(
      true,
    )
  })
})

describe("telemetry integration token-derived tags", () => {
  it("populates ai.user.id tag when tid is parsed from token", async () => {
    mockTelemetryEnabled = true
    installFetchMock(() =>
      Promise.resolve(jsonResponse({ itemsReceived: 1, itemsAccepted: 1 })),
    )

    initTelemetry("tid=user123;exp=9999999999;sku=monthly_subscriber_v2")
    trackEvent("test.event", { model: "gpt-test" })
    await flushMicrotasks()

    const envelope = parseFirstTelemetryEnvelope()
    const tags = envelope.tags as Record<string, string>
    expect(tags["ai.user.id"]).toBe("user123")
  })

  it("gracefully falls back to empty ai.user.id when tid is missing", async () => {
    mockTelemetryEnabled = true
    installFetchMock(() =>
      Promise.resolve(jsonResponse({ itemsReceived: 1, itemsAccepted: 1 })),
    )

    expect(() => {
      initTelemetry("exp=9999999999;sku=monthly_subscriber_v2")
    }).not.toThrow()

    expect(() => {
      trackEvent("test.event", { model: "gpt-test" })
    }).not.toThrow()

    await flushMicrotasks()

    const envelope = parseFirstTelemetryEnvelope()
    const tags = envelope.tags as Record<string, string>
    expect(tags["ai.user.id"]).toBe("")
  })
})

describe("telemetry integration event-specific routing", () => {
  it("sends panel and conversation events to GH with shared context", async () => {
    mockTelemetryEnabled = true
    installFetchMock(() =>
      Promise.resolve(jsonResponse({ itemsReceived: 1, itemsAccepted: 1 })),
    )
    const context = contextFor("req-panel-1", "gpt-test")
    trackPanelRequest(context)
    await flushMicrotasks()

    expect(
      fetchCalls.every((call) => call.url === DIRECT_TELEMETRY_ENDPOINT),
    ).toBe(true)
    expect(
      telemetryEnvelopes().map((event) => event.data.baseData.name),
    ).toEqual([
      "copilot-chat/panel_request",
      "copilot-chat/conversation.message",
      "copilot-chat/conversation.message",
    ])
    const panel = telemetryEvent(
      "copilot-chat/panel_request",
      context.requestId,
    )
    expect(panel.data.baseData.properties).toMatchObject({
      requestId: context.requestId,
      conversationId: context.conversationId,
      languageId: context.languageId,
      model: context.model,
      mode: context.mode,
    })
    expect(JSON.parse(panel.data.baseData.properties.codeBlocks)).toEqual([
      { languageId: context.languageId, totalLines: context.totalLines },
    ])
    expect(panel.data.baseData.measurements).toMatchObject({
      isAgent: context.isAgent,
    })

    const message = telemetryEvent(
      "copilot-chat/conversation.message",
      context.requestId,
      "model",
    )
    expect(message.data.baseData.properties).toMatchObject({
      source: "model",
      conversationId: context.conversationId,
      headerRequestId: context.requestId,
      languageId: context.languageId,
      mode: context.mode,
    })
    expect(message.data.baseData.measurements).toMatchObject({
      messageCharLen: context.totalCharacters,
      numCodeBlocks: 1,
    })

    const userMessage = telemetryEvent(
      "copilot-chat/conversation.message",
      context.requestId,
      "user",
    )
    expect(userMessage.data.baseData.properties).toMatchObject({
      source: "user",
      turnIndex: "0",
      conversationId: context.conversationId,
      headerRequestId: context.requestId,
      languageId: context.languageId,
    })
    expect(userMessage.data.baseData.measurements?.messageCharLen).toBe(
      context.totalCharacters,
    )
  })

  it("sends ghostText.shown with synthetic line statistics and minimal identity", async () => {
    mockTelemetryEnabled = true
    state.organizationList = ["org-a"]
    state.enterpriseList = [999001]
    installFetchMock(() =>
      Promise.resolve(jsonResponse({ itemsReceived: 1, itemsAccepted: 1 })),
    )
    const context = contextFor("req-ghost-1", "gpt-test")
    trackGhostTextShown(context)
    await flushMicrotasks()

    const event = telemetryEvent("copilot/ghostText.shown", context.requestId)
    const { properties, measurements } = event.data.baseData
    expect(properties).toMatchObject({
      headerRequestId: context.requestId,
      conversationId: context.conversationId,
      languageId: context.languageId,
      reason: "network",
      clientCompletionId: context.clientCompletionId,
      completionId: context.clientCompletionId,
      choiceIndex: "0",
    })
    expect(measurements).toMatchObject({
      compCharLen: context.totalCharacters,
      numLines: context.totalLines,
    })
    expect(Object.keys(event.tags).sort()).toEqual([
      "ai.internal.sdkVersion",
      "ai.session.id",
      "ai.user.id",
    ])
    expect(event.tags["ai.session.id"]).toBe("editor-integration")
    expect(properties.common_vscodesessionid).toBe("editor-integration")
    for (const key of [
      "organizations_list",
      "enterprise_list",
      "client_sessionid",
      "client_machineid",
      "client_deviceid",
    ]) {
      expect(properties).not.toHaveProperty(key)
    }
    expect(properties.unique_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })
})

const upstreamTelemetryHeaders = {
  "X-Request-Id": "server-protocol",
  "X-GitHub-Request-Id": "gh-protocol",
  "X-Copilot-Service-Request-Id": "service-protocol",
  "X-GitHub-Copilot-Request-Te": "te-protocol",
}

const protocolScenarios = [
  {
    apiType: "chatCompletions",
    endpoint: "/chat/completions",
    call: (stream: boolean, sessionId?: string) =>
      createChatCompletions({ ...buildPayload(), stream }, { sessionId }),
    response: {
      id: "timed-chat",
      model: "actual-chat",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  },
  {
    apiType: "messages",
    endpoint: "/v1/messages",
    call: (stream: boolean, sessionId?: string) =>
      createMessages(
        {
          model: "claude-test",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
          stream,
        },
        undefined,
        { sessionId },
      ),
    response: {
      id: "timed-messages",
      type: "message",
      role: "assistant",
      model: "actual-messages",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  },
  {
    apiType: "responses",
    endpoint: "/responses",
    call: (stream: boolean, sessionId?: string) =>
      createResponses(
        {
          model: "gpt-test",
          input: [{ role: "user", content: "hello" }],
          stream,
        },
        { vision: false, initiator: "user", transport: "http", sessionId },
      ),
    response: {
      id: "timed-responses",
      model: "actual-responses",
      output: [],
      incomplete_details: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  },
] as const

function protocolStreamResponse(options: {
  apiType: "chatCompletions" | "messages" | "responses"
  body: Record<string, unknown>
  init?: ResponseInit
}): Response {
  const events =
    options.apiType === "chatCompletions" ?
      [
        options.body.model === undefined ?
          { choices: [] }
        : { model: "initial-model", choices: [] },
        options.body,
      ]
    : options.apiType === "messages" ?
      [
        { type: "message_start", message: options.body },
        { type: "message_stop" },
      ]
    : [
        {
          type: "response.created",
          response:
            options.body.model === undefined ?
              options.body
            : { ...options.body, model: "initial-model" },
        },
        { type: "response.completed", response: options.body },
      ]
  const response = new Response(
    events.map((data) => `data: ${JSON.stringify(data)}\n\n`).join("")
      + `data: [DONE]\n\n`,
    options.init,
  )
  response.headers.set("content-type", "text/event-stream")
  return response
}

describe("telemetry integration protocol and timing", () => {
  for (const scenario of protocolScenarios) {
    for (const stream of [false, true]) {
      it(`reports ${scenario.apiType} timing for ${stream ? "streaming" : "JSON"} responses`, async () => {
        mockTelemetryEnabled = true
        let now = 1000
        const clock = spyOn(Date, "now").mockImplementation(() => now)
        const responsePrototype = Response.prototype as Response
        const parseJson: (this: Response) => Promise<unknown> =
          responsePrototype.json
        const jsonTiming = spyOn(responsePrototype, "json").mockImplementation(
          function (this: Response) {
            return parseJson.call(this).then((result) => {
              now = 1120
              return result
            })
          },
        )
        installFetchMock((url) => {
          if (!url.endsWith(scenario.endpoint)) {
            return Promise.resolve(
              jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
            )
          }
          now = 1030
          return Promise.resolve(
            stream ?
              protocolStreamResponse({
                apiType: scenario.apiType,
                body: scenario.response,
                init: { headers: upstreamTelemetryHeaders },
              })
            : jsonResponse(scenario.response, {
                headers: upstreamTelemetryHeaders,
              }),
          )
        })
        try {
          const result = await scenario.call(stream)
          if (stream) {
            now = 1120
            const chunks: Array<ServerSentEventMessage> = []
            for await (const chunk of result as AsyncIterable<ServerSentEventMessage>) {
              chunks.push(chunk)
            }
            expect(
              chunks.some((chunk) =>
                chunk.data?.includes(scenario.response.model),
              ),
            ).toBe(true)
          } else {
            expect(result).toMatchObject({ id: scenario.response.id })
          }
          for (const timer of scheduledTimers) timer.fn()
          await flushMicrotasks()
          const envelopes = telemetryCalls().flatMap(
            (call) =>
              JSON.parse(
                call.options?.body as string,
              ) as Array<TelemetryEnvelope>,
          )
          const event = envelopes.find(
            (envelope) =>
              envelope.data.baseData.name === "copilot-chat/response.success",
          )
          if (!event) throw new Error("Successful response telemetry missing")
          expect(event.data.baseData.properties.apiType).toBe(scenario.apiType)
          const upstream = fetchCalls.find((call) =>
            call.url.endsWith(scenario.endpoint),
          )
          if (!upstream) throw new Error("Upstream request missing")
          const clientRequestId = new Headers(upstream.options?.headers).get(
            "x-request-id",
          )
          if (!clientRequestId) throw new Error("Upstream request ID missing")
          const requestId = upstreamTelemetryHeaders["X-Request-Id"]
          expect(event.data.baseData.properties.requestId).toBe(
            "server-protocol",
          )
          const body = JSON.parse(upstream.options?.body as string) as {
            model: string
          }
          expect(event.data.baseData.properties.modelInvoked).toBe(
            scenario.response.model,
          )
          expect(event.data.baseData.properties.model).toBe(body.model)
          const panel = telemetryEvent("copilot-chat/panel_request", requestId)
          const panelProperties = panel.data.baseData.properties
          const request = telemetryEvent(
            "copilot-chat/request.sent",
            clientRequestId,
          )
          expect(request.data.baseData.properties.headerRequestId).toBe(
            clientRequestId,
          )
          expect(request.data.baseData.properties.headerRequestId).not.toBe(
            requestId,
          )
          expect(request.data.baseData.properties.conversationId).toBe(
            panelProperties.conversationId,
          )
          expect(request.data.baseData.properties).not.toHaveProperty(
            "copilotServiceRequestId",
          )
          for (const envelope of envelopes) {
            if (envelope.data.baseData.name === "copilot-chat/request.sent")
              continue
            expect(envelope.data.baseData.properties).toMatchObject({
              conversationId: panelProperties.conversationId,
              gitHubRequestId: "gh-protocol",
              copilotServiceRequestId: "service-protocol",
              gitHubCopilotRequestTe: "te-protocol",
            })
          }
          const copy = telemetryEvent(
            "copilot-chat/conversation.acceptedCopy",
            requestId,
          )
          for (const source of ["user", "model"]) {
            const message = telemetryEvent(
              "copilot-chat/conversation.message",
              requestId,
              source,
            )
            expect(message.data.baseData.properties.conversationId).toBe(
              panelProperties.conversationId,
            )
            if (source === "model")
              expect(message.data.baseData.properties.messageId).toBe(
                copy.data.baseData.properties.messageId,
              )
          }
          expect(panelProperties.model).toBe(body.model)
          expect(panelProperties.requestId).toBe(requestId)
          const codeBlocks = JSON.parse(panelProperties.codeBlocks) as Array<{
            languageId: string
            totalLines: number
          }>
          expect(codeBlocks[0].languageId).toBe(panelProperties.languageId)
          expect(codeBlocks[0].totalLines).toBeGreaterThan(0)
          const ghost = telemetryEvent("copilot/ghostText.shown", requestId)
          expect(ghost.data.baseData.properties.languageId).toBe(
            panelProperties.languageId,
          )
          expect(ghost.data.baseData.measurements?.numLines).toBe(
            codeBlocks[0].totalLines,
          )
          for (const name of [
            "copilot-chat/panel.edit.feedback",
            "copilot-chat/edit.hunk.action",
            "copilot-chat/conversation.acceptedCopy",
          ]) {
            const properties = telemetryEvent(name, requestId).data.baseData
              .properties
            expect(properties.languageId).toBe(panelProperties.languageId)
            expect(properties.modelId).toBe(body.model)
            expect(properties.mode).toBe(panelProperties.mode)
          }
          expect(copy.data.baseData.measurements?.totalLines).toBe(
            codeBlocks[0].totalLines,
          )
          expect(event.data.baseData.measurements?.timeToFirstToken).toBe(30)
          expect(event.data.baseData.measurements?.timeToComplete).toBe(120)
          expect(event.data.baseData.measurements?.timeSinceIssuedMs).toBe(120)
        } finally {
          jsonTiming.mockRestore()
          clock.mockRestore()
        }
      })
    }

    it(`preserves ${scenario.apiType} session correlation across token refresh`, async () => {
      mockTelemetryEnabled = true
      installFetchMock((url) =>
        Promise.resolve(
          url.endsWith(scenario.endpoint) ?
            jsonResponse(scenario.response)
          : jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
        ),
      )
      const session = `private-session-${scenario.apiType}`
      await scenario.call(false, session)
      initTelemetry("tid=test-user;exp=9999999999;sku=test_sku")
      await scenario.call(false, session)
      await scenario.call(false, `other-session-${scenario.apiType}`)
      for (const timer of scheduledTimers) timer.fn()
      await flushMicrotasks()
      const messages = () =>
        telemetryEnvelopes()
          .filter((envelope) =>
            [
              "copilot-chat/conversation.message",
              "copilot-chat/editingSession.message",
            ].includes(envelope.data.baseData.name),
          )
          .map((envelope) => envelope.data.baseData.properties)
      const properties = messages()
      expect(
        properties.map(({ source, turnIndex }) => [source, turnIndex]),
      ).toEqual([
        ["user", "0"],
        ["model", "1"],
        ["user", "2"],
        ["model", "3"],
        ["user", "0"],
        ["model", "1"],
      ])
      expect(properties[0].conversationId).toBe(properties[2].conversationId)
      expect(properties[0].conversationId).not.toBe(
        properties[4].conversationId,
      )
      expect(JSON.stringify(telemetryEnvelopes())).not.toContain(
        "private-session",
      )
      expect(JSON.stringify(telemetryEnvelopes())).not.toContain(
        "other-session",
      )
      initTelemetry("tid=another-user;exp=9999999999;sku=test_sku")
      await scenario.call(false, session)
      for (const timer of scheduledTimers) timer.fn()
      await flushMicrotasks()
      const afterSwitch = messages()
      expect(afterSwitch[6].source).toBe("user")
      expect(afterSwitch[6].turnIndex).toBe("0")
      expect(afterSwitch[6].conversationId).not.toBe(
        properties[0].conversationId,
      )
    })

    it.each([false, true])(
      `falls back to requested ${scenario.apiType} model when response model is missing, stream=%s`,
      async (stream) => {
        mockTelemetryEnabled = true
        const { model: _model, ...body } = scenario.response
        installFetchMock((url) =>
          Promise.resolve(
            url.endsWith(scenario.endpoint) ?
              stream ?
                protocolStreamResponse({ apiType: scenario.apiType, body })
              : jsonResponse(body)
            : jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
          ),
        )
        const result = await scenario.call(stream)
        if (stream) {
          for await (const chunk of result as AsyncIterable<ServerSentEventMessage>)
            void chunk
        }
        for (const timer of scheduledTimers) timer.fn()
        await flushMicrotasks()
        const upstream = fetchCalls.find((call) =>
          call.url.endsWith(scenario.endpoint),
        )
        if (!upstream) throw new Error("Upstream request missing")
        const requested = JSON.parse(upstream.options?.body as string) as {
          model: string
        }
        expect(
          telemetryEvent("copilot-chat/response.success").data.baseData
            .properties.modelInvoked,
        ).toBe(requested.model)
      },
    )

    it(`preserves malformed ${scenario.apiType} SSE data for the client`, async () => {
      mockTelemetryEnabled = true
      const warn = spyOn(consola, "warn").mockImplementation(
        Object.assign(() => {}, { raw: () => {} }),
      )
      installFetchMock((url) =>
        Promise.resolve(
          url.endsWith(scenario.endpoint) ?
            new Response("data: {invalid\n\ndata: [DONE]\n\n", {
              headers: { "content-type": "text/event-stream" },
            })
          : jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
        ),
      )
      try {
        const result = await scenario.call(true)
        const chunks: Array<ServerSentEventMessage> = []
        for await (const chunk of result as AsyncIterable<ServerSentEventMessage>)
          chunks.push(chunk)
        expect(chunks[0].data).toBe("{invalid")
        for (const timer of scheduledTimers) timer.fn()
        await flushMicrotasks()
        const upstream = fetchCalls.find((call) =>
          call.url.endsWith(scenario.endpoint),
        )
        if (!upstream) throw new Error("Upstream request missing")
        const requested = JSON.parse(upstream.options?.body as string) as {
          model: string
        }
        expect(
          telemetryEvent("copilot-chat/response.success").data.baseData
            .properties.modelInvoked,
        ).toBe(requested.model)
      } finally {
        warn.mockRestore()
      }
    })

    it.each([undefined, ""])(
      `${scenario.apiType} falls back to the client request ID for upstream header %s`,
      async (serverRequestId) => {
        mockTelemetryEnabled = true
        installFetchMock((url) =>
          Promise.resolve(
            url.endsWith(scenario.endpoint) ?
              jsonResponse(scenario.response, {
                headers:
                  serverRequestId === undefined ? {} : { "X-Request-Id": "" },
              })
            : jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
          ),
        )
        await scenario.call(false)
        for (const timer of scheduledTimers) timer.fn()
        await flushMicrotasks()
        const clientRequestId = telemetryEvent("copilot-chat/request.sent").data
          .baseData.properties.headerRequestId
        expect(clientRequestId).toBeTruthy()
        for (const envelope of telemetryEnvelopes()) {
          if (envelope.data.baseData.name === "copilot-chat/request.sent")
            continue
          const properties = envelope.data.baseData.properties
          if ("requestId" in properties)
            expect(properties.requestId).toBe(clientRequestId)
          if ("headerRequestId" in properties)
            expect(properties.headerRequestId).toBe(clientRequestId)
        }
        for (const name of [
          "copilot-chat/response.success",
          "copilot-chat/panel_request",
          "copilot-chat/inline.done",
        ]) {
          expect(
            telemetryEvent(name, clientRequestId).data.baseData.properties
              .requestId,
          ).toBe(clientRequestId)
        }
      },
    )

    it.each(["server-protocol", undefined, ""])(
      `reports ${scenario.apiType} for an upstream HTTP error with request ID %s`,
      async (serverRequestId) => {
        mockTelemetryEnabled = true
        installFetchMock((url) =>
          Promise.resolve(
            url.endsWith(scenario.endpoint) ?
              jsonResponse(
                { error: { message: "service unavailable" } },
                {
                  status: 503,
                  headers:
                    serverRequestId === undefined ?
                      Object.fromEntries(
                        Object.entries(upstreamTelemetryHeaders).filter(
                          ([key]) => key !== "X-Request-Id",
                        ),
                      )
                    : {
                        ...upstreamTelemetryHeaders,
                        "X-Request-Id": serverRequestId ?? "",
                      },
                },
              )
            : jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
          ),
        )
        let upstreamError: unknown
        try {
          await scenario.call(false)
        } catch (error) {
          upstreamError = error
        }
        expect(upstreamError).toBeInstanceOf(HTTPError)
        for (const timer of scheduledTimers) timer.fn()
        await flushMicrotasks()
        const envelopes = telemetryCalls().flatMap(
          (call) =>
            JSON.parse(
              call.options?.body as string,
            ) as Array<TelemetryEnvelope>,
        )
        for (const name of [
          "copilot-chat/panel_request",
          "copilot-chat/inline.done",
          "copilot/ghostText.shown",
          "copilot/ghostText.accepted",
          "copilot-chat/conversation.acceptedCopy",
          "copilot-chat/conversation.acceptedInsert",
          "copilot-chat/conversation.appliedCodeblock",
        ]) {
          expect(
            envelopes.some((envelope) => envelope.data.baseData.name === name),
          ).toBe(false)
        }
        const event = envelopes.find(
          (envelope) =>
            envelope.data.baseData.name === "copilot-chat/response.error",
        )
        if (!event) throw new Error("Failed response telemetry missing")
        expect(event.data.baseData.properties.apiType).toBe(scenario.apiType)
        expect(event.data.baseData.measurements?.status_code).toBe(503)
        const requestProperties = telemetryEvent("copilot-chat/request.sent")
          .data.baseData.properties
        const clientRequestId = requestProperties.headerRequestId
        expect(clientRequestId).toBeTruthy()
        if (serverRequestId) expect(clientRequestId).not.toBe(serverRequestId)
        expect(event.data.baseData.properties).toMatchObject({
          requestId: serverRequestId || clientRequestId,
          gitHubRequestId: "gh-protocol",
          copilotServiceRequestId: "service-protocol",
          gitHubCopilotRequestTe: "te-protocol",
          conversationId: requestProperties.conversationId,
        })
      },
    )
  }
})

describe("telemetry integration per-request sampling", () => {
  for (const scenario of protocolScenarios) {
    it.each([true, false])(
      `${scenario.apiType} keeps sampling decision=%s through the response and timers`,
      async (selected) => {
        mockTelemetryEnabled = true
        let first = true
        Math.random = () => {
          if (first) {
            first = false
            return selected ? 0.1 : 0.9
          }
          return selected ? 0.99 : 0.01
        }
        installFetchMock((url) =>
          Promise.resolve(
            url.endsWith(scenario.endpoint) ?
              jsonResponse(scenario.response, {
                headers: upstreamTelemetryHeaders,
              })
            : jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
          ),
        )
        const result = await scenario.call(false)
        expect(result).toMatchObject({ id: scenario.response.id })
        for (const timer of scheduledTimers) timer.fn()
        await flushMicrotasks()
        if (!selected) {
          expect(telemetryCalls()).toHaveLength(0)
          return
        }
        const request = telemetryEvent("copilot-chat/request.sent")
        const requestId = upstreamTelemetryHeaders["X-Request-Id"]
        const conversationId = request.data.baseData.properties.conversationId
        const panel = telemetryEvent("copilot-chat/panel_request", requestId)
        const response = telemetryEvent(
          "copilot-chat/response.success",
          requestId,
        )
        expect(panel.data.baseData.properties.conversationId).toBe(
          conversationId,
        )
        expect(response.data.baseData.properties.conversationId).toBe(
          conversationId,
        )
        for (const source of ["user", "model"]) {
          const message = telemetryEvent(
            "copilot-chat/conversation.message",
            requestId,
            source,
          )
          expect(message.data.baseData.properties.conversationId).toBe(
            conversationId,
          )
        }
        for (const name of [
          "copilot-chat/inline.done",
          "copilot-chat/inlineConversation.message",
          "copilot-chat/inlineConversation.accept",
          "copilot/ghostText.accepted",
        ]) {
          expect(
            telemetryEvent(name, requestId).data.baseData.properties,
          ).toMatchObject({
            conversationId,
            gitHubRequestId: "gh-protocol",
            copilotServiceRequestId: "service-protocol",
            gitHubCopilotRequestTe: "te-protocol",
          })
        }
        const adoptionNames = [
          "copilot-chat/conversation.acceptedCopy",
          "copilot-chat/conversation.acceptedInsert",
          "copilot-chat/conversation.appliedCodeblock",
        ]
        const adoption = telemetryEnvelopes().find((envelope) =>
          adoptionNames.includes(envelope.data.baseData.name),
        )
        if (!adoption)
          throw new Error("Sampled request lost its adoption telemetry")
        expect(adoption.data.baseData.properties.conversationId).toBe(
          conversationId,
        )
      },
    )
  }
})
