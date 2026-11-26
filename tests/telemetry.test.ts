import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"

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

// --- Mocks must be set up before importing the module under test ---

// Mock config: default telemetry disabled.
// IMPORTANT: must return a **complete** config shape (including extraPrompts)
// so that other test files sharing this process (e.g. codex tests) still see
// the prompts they depend on via getExtraPromptForModel().
let mockTelemetryEnabled: boolean | undefined = false

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

import type { TelemetryEnvelope } from "../src/services/telemetry/types"

import { SESSION_ID, getMachineId } from "../src/services/telemetry/identity"
import {
  initTelemetry,
  trackEvent,
  trackRequestSent,
  trackResponseSuccess,
  trackResponseError,
  trackAuthNewToken,
  trackEditFeedback,
  trackEditHunkAction,
  trackPanelRequest,
  scheduleFeedbackEvents,
} from "../src/services/telemetry/telemetry"
import {
  TELEMETRY_IKEY,
  TELEMETRY_ENVELOPE_NAME,
  MSFT_TELEMETRY_API_KEY,
  MSFT_TELEMETRY_ENDPOINT,
  TELEMETRY_SDK_VERSION,
} from "../src/services/telemetry/types"

// Track fetch calls
let fetchCalls: Array<{
  url: string
  options: { method: string; headers: Record<string, string>; body: string }
}> = []
let originalFetch: typeof globalThis.fetch
let originalRandom: typeof Math.random

beforeEach(() => {
  fetchCalls = []
  originalFetch = globalThis.fetch
  originalRandom = Math.random
  Math.random = () => 0.1 // Always pass the 30% sampling gate in trackEvent
  mockTelemetryEnabled = false
  requestMock.mockClear()
})

afterEach(() => {
  mockTelemetryEnabled = false
  globalThis.fetch = originalFetch
  Math.random = originalRandom
  mock.restore()
})

function installFetchMock(
  response?: Partial<Response>,
): ReturnType<typeof mock> {
  const mockFn = mock(
    (
      url: string,
      opts: { method: string; headers: Record<string, string>; body: string },
    ) => {
      fetchCalls.push({ url, options: opts })
      const defaultBody = response ?? { itemsReceived: 1, itemsAccepted: 1 }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(defaultBody),
        text: () => Promise.resolve(JSON.stringify(defaultBody)),
        ...response,
      })
    },
  )
  globalThis.fetch = mockFn as unknown as typeof fetch
  return mockFn
}

function installFailingFetchMock(): void {
  globalThis.fetch = mock(() =>
    Promise.reject(new Error("network error")),
  ) as unknown as typeof fetch
}

function getTelemetryEnvelopes(): Array<TelemetryEnvelope> {
  return fetchCalls.flatMap((call) => {
    const parsed: unknown = JSON.parse(call.options.body)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter(
      (entry): entry is TelemetryEnvelope =>
        typeof entry === "object" && entry !== null,
    )
  })
}

function findEnvelopeByName(eventName: string): TelemetryEnvelope {
  const match = getTelemetryEnvelopes().find(
    (env) => env.data.baseData.name === eventName,
  )
  if (!match) {
    throw new TypeError(`${eventName} envelope not found`)
  }

  return match
}

function findTelemetryEnvelope(
  eventName: string,
  requestId: string,
): TelemetryEnvelope {
  for (const call of fetchCalls) {
    const body = JSON.parse(call.options.body) as Array<TelemetryEnvelope>
    const match = body.find((env) => {
      return (
        env.data.baseData.name === eventName
        && env.data.baseData.properties.requestId === requestId
      )
    })
    if (match) return match
  }

  throw new TypeError(`${eventName} envelope not found for ${requestId}`)
}

function hasTelemetryEnvelope(
  eventName: string,
  predicate: (env: TelemetryEnvelope) => boolean = () => true,
): boolean {
  return getTelemetryEnvelopes().some(
    (env) => env.data.baseData.name === eventName && predicate(env),
  )
}

/** Wait for fire-and-forget microtasks to settle */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

// ---------------------------------------------------------------------------
// initTelemetry
// ---------------------------------------------------------------------------

describe("telemetry: initTelemetry", () => {
  it("parses tid from copilot token and sets endpoint", () => {
    initTelemetry(
      "tid=abc123;exp=1234567890;sku=monthly",
      "https://custom.endpoint/telemetry",
    )
    mockTelemetryEnabled = true
    installFetchMock()
    trackEvent("test.event", {})

    const customEndpointCall = fetchCalls.find(
      (call) => call.url === "https://custom.endpoint/telemetry",
    )
    expect(customEndpointCall).toBeDefined()

    const env = findEnvelopeByName("test.event")
    expect(env.tags["ai.user.id"]).toBe("abc123")
  })
})

// ---------------------------------------------------------------------------
// trackEvent core behaviour
// ---------------------------------------------------------------------------

describe("telemetry: trackEvent", () => {
  it("sends fetch when telemetry is enabled", async () => {
    mockTelemetryEnabled = true
    installFetchMock()
    initTelemetry("tid=user42;exp=999;sku=free")

    trackEvent("copilot-chat/request.sent", { model: "gpt-4" })
    await flushMicrotasks()

    const env = findEnvelopeByName("copilot-chat/request.sent")
    expect(env.data.baseData.properties.model).toBe("gpt-4")
    const call = fetchCalls.find((candidate) =>
      candidate.options.body.includes("copilot-chat/request.sent"),
    )
    expect(call).toBeDefined()
    expect(call?.options.method).toBe("POST")
    expect(call?.options.headers["Content-Type"]).toBe("application/json")
  })

  it("does NOT send fetch when telemetry is false", () => {
    mockTelemetryEnabled = false
    installFetchMock()

    trackEvent("test.event", { model: "gpt-4" })

    expect(hasTelemetryEnvelope("test.event")).toBe(false)
  })

  it("does NOT send fetch when telemetry field is undefined (default disabled)", () => {
    mockTelemetryEnabled = undefined
    installFetchMock()

    trackEvent("test.event", { model: "gpt-4" })

    expect(hasTelemetryEnvelope("test.event")).toBe(false)
  })

  it("does NOT throw when fetch fails (fire-and-forget)", async () => {
    mockTelemetryEnabled = true
    installFailingFetchMock()

    expect(() => {
      trackEvent("test.event", { model: "gpt-4" })
    }).not.toThrow()

    await flushMicrotasks()
  })

  it("builds correct envelope structure", async () => {
    mockTelemetryEnabled = true
    installFetchMock()
    initTelemetry("tid=envelope-test;exp=1;sku=pro")

    trackEvent(
      "copilot-chat/response.success",
      { model: "gpt-4", status_code: "200" },
      { response_time: 1500 },
    )
    await flushMicrotasks()

    const env = findEnvelopeByName("copilot-chat/response.success")
    expect(env.ver).toBe(1)
    expect(env.name).toBe(TELEMETRY_ENVELOPE_NAME)
    expect(env.iKey).toBe(TELEMETRY_IKEY)
    expect(env.sampleRate).toBe(100)
    expect(typeof env.time).toBe("string")

    expect(env.tags["ai.user.id"]).toBe("envelope-test")
    expect(env.tags["ai.session.id"]).toBe(SESSION_ID)
    expect(env.tags["ai.cloud.roleInstance"]).toBe("REDACTED")
    expect(env.tags["ai.internal.sdkVersion"]).toBe(TELEMETRY_SDK_VERSION)

    expect(env.data.baseType).toBe("EventData")
    expect(env.data.baseData.ver).toBe(2)
    expect(env.data.baseData.name).toBe("copilot-chat/response.success")
    expect(env.data.baseData.properties.model).toBe("gpt-4")
    expect(env.data.baseData.properties.status_code).toBe("200")
    expect(env.data.baseData.properties.common_vscodemachineid).toBe(
      getMachineId(),
    )
    expect(env.data.baseData.measurements).toEqual({ response_time: 1500 })
  })
})

// ---------------------------------------------------------------------------
// request / response wrappers
// ---------------------------------------------------------------------------

describe("telemetry: request/response wrappers", () => {
  it("trackRequestSent sends correct event with enhanced properties", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    trackRequestSent("claude-3.5-sonnet", "individual", "req-abc-123")
    await flushMicrotasks()

    const env = getTelemetryEnvelopes().find(
      (candidate) =>
        candidate.data.baseData.name === "copilot-chat/request.sent"
        && candidate.data.baseData.properties.headerRequestId === "req-abc-123",
    )
    if (!env) {
      throw new TypeError("request.sent envelope not found for req-abc-123")
    }
    expect(env.data.baseData.name).toBe("copilot-chat/request.sent")
    const props = env.data.baseData.properties
    expect("model" in props).toBe(false)
    expect("accountType" in props).toBe(false)
    expect(props.endpoint).toBe("completions")
    expect(props.engineName).toBe("chat")
    expect(typeof props.uiKind).toBe("string")
    expect(props.transport).toBe("http")
    expect(props.headerRequestId).toBe("req-abc-123")
    expect(props.request_option_model).toBe('"claude-3.5-sonnet"')
    expect("request.option.model" in props).toBe(false)
    const m = env.data.baseData.measurements
    expect(m).toBeDefined()
    if (!m) throw new TypeError("measurements missing for request.sent")
    expect(m.maxTokenWindow).toBe(128000)
  })

  it("trackResponseSuccess sends correct event with full measurements", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    trackResponseSuccess({
      model: "gpt-4",
      durationMs: 1234,
      requestId: "req-xyz-789",
      finishReason: "stop",
      promptTokens: 500,
      completionTokens: 300,
      timeToFirstToken: 180,
      bytesReceived: 4096,
    })
    await flushMicrotasks()

    const env = findTelemetryEnvelope(
      "copilot-chat/response.success",
      "req-xyz-789",
    )
    expect(env.data.baseData.name).toBe("copilot-chat/response.success")
    const props = env.data.baseData.properties
    expect(props.model).toBe("gpt-4")
    expect(props.modelInvoked).toBe("gpt-4")
    expect(props.reason).toBe("stop")
    expect(props.source).toBe("panel")
    expect(props.initiatorType).toBe("user")
    expect(props.apiType).toBe("chatCompletions")
    expect(props.requestId).toBe("req-xyz-789")
    expect(props.transport).toBe("http")
    const m = env.data.baseData.measurements
    expect(m).toBeDefined()
    if (!m) throw new TypeError("measurements missing")
    expect(m.totalTokenMax).toBe(128000)
    expect(m.tokenCountMax).toBe(8192)
    expect(m.promptTokenCount).toBe(500)
    expect(m.completionTokens).toBe(300)
    expect(m.timeToFirstToken).toBe(180)
    expect(m.timeToComplete).toBe(1234)
    expect(m.bytesReceived).toBe(4096)
  })

  it("trackResponseSuccess defaults to zero when optional fields omitted", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    trackResponseSuccess({ model: "gpt-4", durationMs: 800 })
    await flushMicrotasks()

    const env = findEnvelopeByName("copilot-chat/response.success")
    const m = env.data.baseData.measurements
    expect(m).toBeDefined()
    if (!m) throw new TypeError("measurements missing")
    expect(m.promptTokenCount).toBe(0)
    expect(m.completionTokens).toBe(0)
    expect(m.bytesReceived).toBe(0)
    expect(m.timeToFirstToken).toBeGreaterThanOrEqual(1)
    expect(m.timeToFirstToken).toBeLessThan(800)
    expect(env.data.baseData.properties.reason).toBe("stop")
    expect(env.data.baseData.properties.requestId).toBe("")
  })

  it("trackResponseError sends correct event with enhanced properties", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    trackResponseError({
      model: "gpt-4",
      durationMs: 500,
      statusCode: 429,
      requestId: "req-err-456",
    })
    await flushMicrotasks()

    const env = findTelemetryEnvelope(
      "copilot-chat/response.error",
      "req-err-456",
    )
    expect(env.data.baseData.name).toBe("copilot-chat/response.error")
    const props = env.data.baseData.properties
    expect(props.model).toBe("gpt-4")
    expect(props.modelInvoked).toBe("gpt-4")
    expect(props.reason).toBe("error")
    expect(props.source).toBe("panel")
    expect(props.initiatorType).toBe("user")
    expect(props.apiType).toBe("chatCompletions")
    expect(props.requestId).toBe("req-err-456")
    expect(props.transport).toBe("http")
    const m = env.data.baseData.measurements
    expect(m).toBeDefined()
    if (!m) throw new TypeError("measurements missing")
    expect(m.duration_ms).toBe(500)
    expect(m.status_code).toBe(429)
    expect(m.timeToComplete).toBe(500)
  })

  for (const apiType of ["chatCompletions", "messages", "responses"] as const) {
    it(`reports ${apiType} for successful and failed responses`, async () => {
      mockTelemetryEnabled = true
      installFetchMock()
      const requestId = `req-api-${apiType}`
      trackResponseSuccess({
        model: "gpt-test",
        durationMs: 100,
        apiType,
        requestId,
      })
      trackResponseError({
        model: "gpt-test",
        durationMs: 100,
        statusCode: 503,
        apiType,
        requestId,
      })
      await flushMicrotasks()
      expect(
        findTelemetryEnvelope("copilot-chat/response.success", requestId).data
          .baseData.properties.apiType,
      ).toBe(apiType)
      expect(
        findTelemetryEnvelope("copilot-chat/response.error", requestId).data
          .baseData.properties.apiType,
      ).toBe(apiType)
    })
  }

  for (const durationMs of [0, 1, 5, 9, 10]) {
    it(`keeps an estimated first-token time within a ${durationMs}ms response`, async () => {
      mockTelemetryEnabled = true
      installFetchMock()
      const requestId = `req-short-${durationMs}`
      trackResponseSuccess({ model: "gpt-test", durationMs, requestId })
      await flushMicrotasks()
      const measurements = findTelemetryEnvelope(
        "copilot-chat/response.success",
        requestId,
      ).data.baseData.measurements
      if (!measurements) throw new Error("Response measurements missing")
      expect(measurements.timeToFirstToken).toBeGreaterThanOrEqual(0)
      expect(measurements.timeToFirstToken).toBeLessThanOrEqual(durationMs)
      expect(measurements.timeToComplete).toBe(durationMs)
    })
  }

  it("trackAuthNewToken sends correct event", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    trackAuthNewToken()
    await flushMicrotasks()

    const env = findEnvelopeByName("copilot-chat/auth.new_token")
    expect(env.data.baseData.name).toBe("copilot-chat/auth.new_token")
  })

  it("trackPanelRequest sends OneCollector payload with aria api key", async () => {
    mockTelemetryEnabled = true

    trackPanelRequest({ headerRequestId: "req-panel-001" })
    await flushMicrotasks()

    const requestCalls = requestMock.mock.calls as Array<Array<unknown>>
    const call = requestCalls.find((candidate) => {
      const options = candidate[1]
      if (typeof options !== "object" || options === null) {
        return false
      }

      const body = (options as { body?: unknown }).body
      if (typeof body !== "string") {
        return false
      }

      return body.includes('"headerRequestId":"req-panel-001"')
    })
    if (!call) {
      throw new TypeError("request call missing")
    }
    const url = call[0]
    const options = call[1]
    if (typeof url !== "string") {
      throw new TypeError("request url missing")
    }
    if (typeof options !== "object" || options === null) {
      throw new TypeError("request options missing")
    }
    expect(url).toBe(MSFT_TELEMETRY_ENDPOINT)
    expect(
      (options as { headers: Record<string, string> }).headers.apikey,
    ).toBe(MSFT_TELEMETRY_API_KEY)

    const payload = JSON.parse((options as { body: string }).body) as {
      name: string
      iKey: string
      data: { baseData: { name: string; properties: Record<string, string> } }
    }
    expect(payload.name).toBe("panel.request")
    expect(payload.iKey.startsWith("o:")).toBe(true)
    expect(payload.data.baseData.name).toBe("panel.request")
    expect(payload.data.baseData.properties.headerRequestId).toBe(
      "req-panel-001",
    )
  })
})

// ---------------------------------------------------------------------------
// feedback wrappers (edit feedback / hunk action / scheduler)
// ---------------------------------------------------------------------------

describe("telemetry: feedback wrappers", () => {
  it("trackEditFeedback sends correct event with properties and measurements", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    // Mock Math.random to deterministically produce "accepted" (< 0.55)
    const origRandom = Math.random
    Math.random = () => 0.1

    trackEditFeedback("req-feedback-001")

    Math.random = origRandom
    await flushMicrotasks()

    const env = findTelemetryEnvelope(
      "copilot-chat/panel.edit.feedback",
      "req-feedback-001",
    )
    expect(env.data.baseData.name).toBe("copilot-chat/panel.edit.feedback")
    const props = env.data.baseData.properties
    expect(props.requestId).toBe("req-feedback-001")
    expect(props.outcome).toBe("accepted")
    expect(props.hasRemainingEdits).toBe("false")
    expect(typeof props.languageId).toBe("string")
    expect(typeof props.participant).toBe("string")
    expect(typeof props.command).toBe("string")
    const m = env.data.baseData.measurements
    expect(m).toBeDefined()
    if (!m) throw new TypeError("measurements missing")
    expect(m.isNotebook).toBe(0)
    expect(m.isNotebookCell).toBe(0)
  })

  it("trackEditHunkAction sends correct event with line stats", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    // Mock Math.random to deterministically produce "accepted" (< 0.55)
    const origRandom = Math.random
    Math.random = () => 0.1

    trackEditHunkAction("req-hunk-002")

    Math.random = origRandom
    await flushMicrotasks()

    const env = findTelemetryEnvelope(
      "copilot-chat/edit.hunk.action",
      "req-hunk-002",
    )
    expect(env.data.baseData.name).toBe("copilot-chat/edit.hunk.action")
    const props = env.data.baseData.properties
    expect(props.requestId).toBe("req-hunk-002")
    expect(props.outcome).toBe("accepted")
    expect(typeof props.languageId).toBe("string")
    const m = env.data.baseData.measurements
    expect(m).toBeDefined()
    if (!m) throw new TypeError("measurements missing")
    expect(m.hasRemainingEdits).toBe(0)
    expect(m.isNotebook).toBe(0)
    expect(m.isNotebookCell).toBe(0)
    expect(typeof m.lineCount).toBe("number")
    expect(typeof m.linesAdded).toBe("number")
    expect(typeof m.linesRemoved).toBe("number")
  })

  it("scheduleFeedbackEvents shares feedback choices with varying random values", async () => {
    mockTelemetryEnabled = true
    installFetchMock()
    const captured: { fn: (() => void) | null; delay: number } = {
      fn: null,
      delay: 0,
    }
    const origTimeout = globalThis.setTimeout
    const origRandom = Math.random
    const randomValues = [0.1, 0.2, 0.8, 0.1, 0.9, 0.1, 0.9, 0.1, 0.9, 0.1]
    let randomIndex = 0
    try {
      globalThis.setTimeout = ((fn: () => void, ms: number) => {
        captured.fn = fn
        captured.delay = ms
        return 0 as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout
      Math.random = () => randomValues[randomIndex++] ?? 0.1
      scheduleFeedbackEvents("req-sched-003")
      expect(fetchCalls.length).toBe(0)
      expect(captured.delay).toBeGreaterThanOrEqual(2000)
      expect(captured.delay).toBeLessThanOrEqual(15000)
      if (!captured.fn) throw new Error("setTimeout callback not captured")
      captured.fn()
    } finally {
      globalThis.setTimeout = origTimeout
      Math.random = origRandom
    }
    await flushMicrotasks()
    const feedback = findTelemetryEnvelope(
      "copilot-chat/panel.edit.feedback",
      "req-sched-003",
    ).data.baseData.properties
    const hunk = findTelemetryEnvelope(
      "copilot-chat/edit.hunk.action",
      "req-sched-003",
    ).data.baseData.properties
    expect(feedback.languageId).toBe("javascript")
    expect(feedback.outcome).toBe("rejected")
    expect(hunk.languageId).toBe(feedback.languageId)
    expect(hunk.outcome).toBe(feedback.outcome)
  })

  it("scheduleFeedbackEvents skips when requestId is empty", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    scheduleFeedbackEvents("")
    await flushMicrotasks()
    expect(
      hasTelemetryEnvelope(
        "copilot-chat/panel.edit.feedback",
        (env) => env.data.baseData.properties.requestId === "",
      ),
    ).toBe(false)
    expect(
      hasTelemetryEnvelope(
        "copilot-chat/edit.hunk.action",
        (env) => env.data.baseData.properties.requestId === "",
      ),
    ).toBe(false)
  })
})
