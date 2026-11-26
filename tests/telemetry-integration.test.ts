import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test"

const requestMock = mock(() =>
  Promise.resolve({
    statusCode: 200,
    body: {
      text: () => Promise.resolve('{"acc":1}'),
    },
  }),
)

void mock.module("undici", () => ({
  request: requestMock,
}))

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
import type { TelemetryEnvelope } from "~/services/telemetry/types"
import {
  initTelemetry,
  trackAuthNewToken,
  trackEvent,
  trackGhostTextShown,
  trackPanelRequest,
} from "~/services/telemetry/telemetry"
import {
  DEFAULT_TELEMETRY_ENDPOINT,
  MSFT_TELEMETRY_API_KEY,
  MSFT_TELEMETRY_ENDPOINT,
} from "~/services/telemetry/types"

const DIRECT_TELEMETRY_ENDPOINT = DEFAULT_TELEMETRY_ENDPOINT

type FetchCall = {
  url: string
  options?: RequestInit
}

let fetchCalls: Array<FetchCall> = []
let originalFetch: typeof globalThis.fetch
let originalRandom: typeof Math.random

const chatResponse = {
  id: "chat-ok",
  object: "chat.completion",
  created: 0,
  model: "gpt-test",
  choices: [],
}

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json",
    },
  })
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

function msftTrackCalls(): Array<FetchCall> {
  return requestMock.mock.calls.reduce<Array<FetchCall>>((acc, call) => {
    const [url, options] = call as Array<unknown>
    if (typeof url === "string") {
      acc.push({ url, options: options as RequestInit })
    }
    return acc
  }, [])
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

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function parseFirstBody(url: string): unknown {
  const call =
    url === MSFT_TELEMETRY_ENDPOINT ?
      msftTrackCalls().at(0)
    : fetchCalls.find((x) => x.url === url)
  expect(call).toBeDefined()

  const body = call?.options?.body
  expect(typeof body).toBe("string")
  return JSON.parse((body ?? "null") as string)
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
  Math.random = () => 0.1 // Always pass the 30% sampling gate in trackEvent
  mockTelemetryEnabled = false
  requestMock.mockClear()

  state.copilotToken = "test-copilot-token"
  state.copilotApiUrl = undefined
  state.copilotTrackingId = undefined
  state.copilotTelemetryEnabled = undefined
  state.githubToken = "test-github-token"
  state.vsCodeVersion = "1.0.0"
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
  it("routes panel.request to the MSFT telemetry channel", async () => {
    mockTelemetryEnabled = true
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

    initTelemetry("tid=user123;exp=9999999999;sku=copilot_for_business")
    trackPanelRequest({ headerRequestId: "req-panel-1" })
    await flushMicrotasks()

    expect(msftTrackCalls().length).toBe(1)
    expect(telemetryCalls().length).toBe(0)

    const payload = parseFirstBody(MSFT_TELEMETRY_ENDPOINT)
    const first = payload as Record<string, unknown>
    expect(first.name).toBeDefined()
    const data = first.data as Record<string, unknown>
    const baseData = data.baseData as Record<string, unknown>
    expect(baseData.name).toBe("panel.request")
    const call = requestMock.mock.calls[0] as Array<unknown> | undefined
    if (!call) {
      throw new TypeError("request call missing")
    }
    const requestUrl = call[0]
    const options = call[1]
    if (typeof requestUrl !== "string") {
      throw new TypeError("request url missing")
    }
    if (typeof options !== "object" || options === null) {
      throw new TypeError("request options missing")
    }
    expect(requestUrl).toBe(MSFT_TELEMETRY_ENDPOINT)
    expect(
      (options as { headers: Record<string, string> }).headers.apikey,
    ).toBe(MSFT_TELEMETRY_API_KEY)
  })

  it("sends ghostText.shown to GH telemetry with vendor-required fields", async () => {
    mockTelemetryEnabled = true
    state.organizationList = ["org-a", "org-b"]
    state.enterpriseList = [999001]
    installFetchMock((url) => {
      if (url === DIRECT_TELEMETRY_ENDPOINT) {
        return Promise.resolve(
          jsonResponse({ itemsReceived: 1, itemsAccepted: 1 }),
        )
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })

    initTelemetry("tid=user123;exp=9999999999;sku=copilot_for_business")
    trackGhostTextShown({
      headerRequestId: "req-ghost-1",
      copilot_trackingId: "track-1",
      clientCompletionId: "completion-1",
      reason: "network",
      choiceIndex: 0,
      sku: "copilot_for_business",
    })
    await flushMicrotasks()

    expect(telemetryCalls().length).toBe(1)
    const envelope = parseFirstTelemetryEnvelope()
    const data = envelope.data as Record<string, unknown>
    const baseData = data.baseData as Record<string, unknown>
    expect(baseData.name).toBe("copilot/ghostText.shown")

    const properties = baseData.properties as Record<string, string>
    expect(properties.copilot_trackingId).toBe("track-1")
    expect(properties.clientCompletionId).toBe("completion-1")
    expect(properties.organizations_list).toBe("org-a,org-b")
    expect(properties.enterprise_list).toBe("999001")
    expect(properties.client_sessionid).toBeDefined()
    expect(properties.editor_version).toBeDefined()
    expect(properties.editor_plugin_version).toBeDefined()
    expect(properties.copilot_version).toBeDefined()
    expect(properties.unique_id).toBeDefined()

    const measurements = baseData.measurements as Record<string, number>
    expect(typeof measurements.timeSinceIssuedMs).toBe("number")
    expect(typeof measurements.timeSinceDisplayedMs).toBe("number")
    expect(typeof measurements.current_time).toBe("number")
  })
})

const protocolScenarios = [
  {
    apiType: "chatCompletions",
    endpoint: "/chat/completions",
    call: (stream: boolean) =>
      createChatCompletions({ ...buildPayload(), stream }),
    response: {
      id: "timed-chat",
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
    call: (stream: boolean) =>
      createMessages(
        {
          model: "claude-test",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
          stream,
        },
        undefined,
      ),
    response: {
      id: "timed-messages",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  },
  {
    apiType: "responses",
    endpoint: "/responses",
    call: (stream: boolean) =>
      createResponses(
        {
          model: "gpt-test",
          input: [{ role: "user", content: "hello" }],
          stream,
        },
        { vision: false, initiator: "user", transport: "http" },
      ),
    response: {
      id: "timed-responses",
      output: [],
      incomplete_details: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  },
] as const

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
          return Promise.resolve(jsonResponse(scenario.response))
        })
        try {
          const result = await scenario.call(stream)
          if (!stream)
            expect(result).toMatchObject({ id: scenario.response.id })
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
          expect(event.data.baseData.measurements?.timeToFirstToken).toBe(30)
          expect(event.data.baseData.measurements?.timeToComplete).toBe(
            stream ? 30 : 120,
          )
        } finally {
          jsonTiming.mockRestore()
          clock.mockRestore()
        }
      })
    }

    it(`reports ${scenario.apiType} for an upstream HTTP error`, async () => {
      mockTelemetryEnabled = true
      installFetchMock((url) =>
        Promise.resolve(
          url.endsWith(scenario.endpoint) ?
            jsonResponse(
              { error: { message: "service unavailable" } },
              { status: 503 },
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
      await flushMicrotasks()
      const envelopes = telemetryCalls().flatMap(
        (call) =>
          JSON.parse(call.options?.body as string) as Array<TelemetryEnvelope>,
      )
      const event = envelopes.find(
        (envelope) =>
          envelope.data.baseData.name === "copilot-chat/response.error",
      )
      if (!event) throw new Error("Failed response telemetry missing")
      expect(event.data.baseData.properties.apiType).toBe(scenario.apiType)
      expect(event.data.baseData.measurements?.status_code).toBe(503)
    })
  }
})
