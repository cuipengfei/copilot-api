import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test"
import consola from "consola"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PATHS } from "~/lib/storage/paths"

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

import {
  initTelemetry,
  trackEvent,
  trackRequestSent,
  trackResponseSuccess,
  trackResponseError,
  captureStreamResponseModel,
  trackAuthNewToken,
} from "../src/services/telemetry/telemetry"
import {
  TELEMETRY_IKEY,
  TELEMETRY_ENVELOPE_NAME,
  TELEMETRY_SDK_VERSION,
} from "../src/services/telemetry/types"
import { createMockRequestContext } from "../src/services/telemetry/mock-values"
import { state } from "~/lib/state"

// Track fetch calls
let fetchCalls: Array<{
  url: string
  options: { method: string; headers: Record<string, string>; body: string }
}> = []
let originalFetch: typeof globalThis.fetch
let originalRandom: typeof Math.random
const originalAppDir = PATHS.APP_DIR
let appDir: string

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "telemetry-core-"))
  PATHS.APP_DIR = appDir
  fetchCalls = []
  originalFetch = globalThis.fetch
  originalRandom = Math.random
  Math.random = () => 0.1 // Always pass the 30% sampling gate in trackEvent
  mockTelemetryEnabled = false
  state.vsCodeSessionId = "editor-core"
  state.macMachineId = "machine-core"
  state.vsCodeDeviceId = "device-core"
})

afterEach(() => {
  PATHS.APP_DIR = originalAppDir
  rmSync(appDir, { recursive: true, force: true })
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

    expect(fetchCalls).toHaveLength(0)
  })

  it("does NOT send fetch when telemetry field is undefined (default disabled)", () => {
    mockTelemetryEnabled = undefined
    installFetchMock()

    trackEvent("test.event", { model: "gpt-4" })

    expect(fetchCalls).toHaveLength(0)
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

    expect(env.tags).toEqual({
      "ai.cloud.roleInstance": "REDACTED",
      "ai.user.id": "envelope-test",
      "ai.session.id": "editor-core",
      "ai.internal.sdkVersion": TELEMETRY_SDK_VERSION,
    })

    expect(env.data.baseType).toBe("EventData")
    expect(env.data.baseData.ver).toBe(2)
    expect(env.data.baseData.name).toBe("copilot-chat/response.success")
    const props = env.data.baseData.properties
    expect(Object.keys(props).sort()).toEqual([
      "client_deviceid",
      "client_machineid",
      "client_sessionid",
      "common_extname",
      "common_extversion",
      "common_isnewappinstall",
      "common_remotename",
      "common_uikind",
      "common_vscodemachineid",
      "common_vscodesessionid",
      "common_vscodeversion",
      "copilot_trackingId",
      "editor_plugin_version",
      "editor_version",
      "model",
      "sku",
      "status_code",
      "unique_id",
    ])
    expect(props.unique_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(props.copilot_trackingId).toBe("envelope-test")
    expect(props.model).toBe("gpt-4")
    expect(props.status_code).toBe("200")
    expect(props.common_extname).toBe("copilot-chat")
    expect(typeof props.common_extversion).toBe("string")
    expect(typeof props.common_vscodeversion).toBe("string")
    expect(typeof props.editor_version).toBe("string")
    expect(typeof props.editor_plugin_version).toBe("string")
    expect(props.editor_version).toBe(`vscode/${props.common_vscodeversion}`)
    expect(props.editor_plugin_version).toBe(
      `copilot-chat/${props.common_extversion}`,
    )
    expect(props.sku).toBe("pro")
    expect(props.common_vscodesessionid).toBe("editor-core")
    expect(props.common_vscodemachineid).toBe("machine-core")
    expect(props.client_machineid).toBe("machine-core")
    expect(props.client_deviceid).toBe("device-core")
    expect(props.client_sessionid).toBe("editor-core")
    expect(env.tags["ai.cloud.roleInstance"]).toBe("REDACTED")
    for (const key of [
      "common_cpu",
      "hostname",
      "common_os",
      "common_platformversion",
      "common_arch",
      "organizations_list",
      "enterprise_list",
    ]) {
      expect(key in env.tags).toBe(false)
      expect(key in props).toBe(false)
    }
    expect(readdirSync(appDir)).toEqual([])
    expect(env.data.baseData.measurements).toEqual({
      response_time: 1500,
      timeSinceIssuedMs: 0,
    })
  })

  it("logs accepted telemetry on first success and every 10th success per event", async () => {
    mockTelemetryEnabled = true
    initTelemetry("tid=log-test;exp=1;sku=pro")
    installFetchMock()
    const infoSpy = spyOn(consola, "info").mockImplementation(
      Object.assign(() => {}, { raw: () => {} }),
    )

    for (let i = 0; i < 21; i++) {
      trackEvent("copilot-chat/panel_request", {})
    }
    for (let i = 0; i < 2; i++) {
      trackEvent("copilot-chat/response.success", {})
    }
    await flushMicrotasks()

    expect(infoSpy.mock.calls).toEqual([
      ["[telemetry] accepted:", "copilot-chat/panel_request", "count=1"],
      ["[telemetry] accepted:", "copilot-chat/panel_request", "count=10"],
      ["[telemetry] accepted:", "copilot-chat/panel_request", "count=20"],
      ["[telemetry] accepted:", "copilot-chat/response.success", "count=1"],
    ])
    expect(infoSpy).toHaveBeenCalledTimes(4)
  })
})

// ---------------------------------------------------------------------------
// request / response wrappers
// ---------------------------------------------------------------------------

const sampledResponse = {
  sampled: true,
  conversationId: "conversation-response",
} as const

describe("telemetry: request/response wrappers", () => {
  it("does not decode unsampled or disabled stream data", () => {
    const context = {
      ...createMockRequestContext({
        requestId: "gating-request",
        model: "requested-model",
      }),
      sampled: false,
    }
    const chunk = {
      get data(): string {
        throw new Error("should not decode")
      },
    }

    mockTelemetryEnabled = true
    captureStreamResponseModel({ context, chunk, apiType: "chatCompletions" })
    expect(context.modelInvoked).toBeUndefined()

    context.sampled = true
    mockTelemetryEnabled = false
    captureStreamResponseModel({ context, chunk, apiType: "chatCompletions" })
    expect(context.modelInvoked).toBeUndefined()
  })

  it("trackRequestSent sends correct event with enhanced properties", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    const context = {
      ...createMockRequestContext({
        requestId: "req-abc-123",
        model: "claude-3.5-sonnet",
      }),
      sampled: true,
      conversationId: "conversation-req-abc",
      issuedAt: 1000,
      gitHubRequestId: "gh-request",
      copilotServiceRequestId: "service-request",
      gitHubCopilotRequestTe: "te-value",
    }
    spyOn(Date, "now").mockReturnValue(1025)
    Math.random = () => 0.99
    trackRequestSent({ context, modelCallId: "model-call-abc" })
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
    expect(props.conversationId).toBe("conversation-req-abc")
    expect(props.modelCallId).toBe("model-call-abc")
    expect(props.gitHubRequestId).toBe("gh-request")
    expect(props.copilotServiceRequestId).toBe("service-request")
    expect(props.gitHubCopilotRequestTe).toBe("te-value")
    expect(props["request.option.model"]).toBe('"claude-3.5-sonnet"')
    const m = env.data.baseData.measurements
    expect(m).toBeDefined()
    if (!m) throw new TypeError("measurements missing for request.sent")
    expect(m.maxTokenWindow).toBe(128000)
    expect(m).toEqual({ maxTokenWindow: 128000, timeSinceIssuedMs: 25 })
  })

  it("trackResponseSuccess sends correct event with full measurements", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    Math.random = () => 0.99
    trackResponseSuccess({
      ...sampledResponse,
      model: "gpt-4",
      modelInvoked: "actual-model",
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
    expect(props.modelInvoked).toBe("actual-model")
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

    trackResponseSuccess({
      ...sampledResponse,
      model: "gpt-4",
      durationMs: 800,
    })
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
    expect(env.data.baseData.properties.modelInvoked).toBe("gpt-4")
    expect(env.data.baseData.properties.reason).toBe("stop")
    expect(env.data.baseData.properties.requestId).toBe("")
  })

  it("trackResponseError sends correct event with enhanced properties", async () => {
    mockTelemetryEnabled = true
    installFetchMock()

    Math.random = () => 0.99
    trackResponseError({
      ...sampledResponse,
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
        ...sampledResponse,
        model: "gpt-test",
        durationMs: 100,
        apiType,
        requestId,
      })
      trackResponseError({
        ...sampledResponse,
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
      trackResponseSuccess({
        ...sampledResponse,
        model: "gpt-test",
        durationMs,
        requestId,
      })
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
    expect(env.data.baseData.properties.trackingId).toBeUndefined()
    expect(typeof env.data.baseData.properties.telemetryEnabled).toBe("string")
  })

  it("does not send unsampled responses even when random sampling would pass", async () => {
    mockTelemetryEnabled = true
    installFetchMock()
    Math.random = () => 0.01

    trackResponseSuccess({
      ...sampledResponse,
      sampled: false,
      model: "gpt-test",
      durationMs: 10,
    })
    trackResponseError({
      ...sampledResponse,
      sampled: false,
      model: "gpt-test",
      durationMs: 10,
      statusCode: 503,
    })
    await flushMicrotasks()

    expect(getTelemetryEnvelopes().length).toBe(0)
  })
})
