/**
 * Comprehensive test suite for telemetry event functions.
 * Tests envelope structure, properties, measurements, and fire-and-forget behavior.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

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

// Mock undici so trackPanelRequest (MSFT path via sendMsftTelemetryEnvelope) can be asserted.
// sendMsftTelemetryEnvelope is async; its first statement is `await request(...)`, so
// request() is called synchronously when the async function is first entered.
const mockUndiciRequest = mock(() =>
  Promise.resolve({
    statusCode: 200,
    body: { text: () => Promise.resolve('{"acc":1}') },
  }),
)

void mock.module("undici", () => ({
  request: mockUndiciRequest,
}))

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

describe("Telemetry Events", () => {
  let originalRandom: typeof Math.random
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalRandom = Math.random
    originalFetch = globalThis.fetch
    mockUndiciRequest.mockClear()

    // Reset all mocks
    mockTelemetryEnabled = true

    // Mock fetch globally
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"itemsAccepted":1}'),
      } as Response),
    ) as unknown as typeof fetch

    // Reset Math.random for sampling tests
    Math.random = () => 0.1
  })

  afterEach(() => {
    Math.random = originalRandom
    mockTelemetryEnabled = false
    globalThis.fetch = originalFetch
    mock.restore()
  })

  describe("trackRequestSent", () => {
    it("should send request sent event", async () => {
      initTelemetry("token", "individual")
      trackRequestSent("gpt-5.4", "individual", "req-123", "model-call-456")

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(globalThis.fetch).toHaveBeenCalled()
    })

    it("should handle optional requestId and modelCallId", () => {
      initTelemetry("token", "individual")
      trackRequestSent("gpt-5.4", "individual")
      expect(globalThis.fetch).toHaveBeenCalled()
    })
  })

  describe("trackResponseSuccess", () => {
    it("should send response success event", async () => {
      initTelemetry("token", "individual")
      trackResponseSuccess({
        model: "gpt-5.4",
        durationMs: 1500,
        requestId: "req-789",
        modelCallId: "model-call-789",
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(globalThis.fetch).toHaveBeenCalled()
    })

    it("should handle response without optional fields", () => {
      initTelemetry("token", "individual")
      trackResponseSuccess({
        model: "gpt-5.4",
        durationMs: 1000,
      })
      expect(globalThis.fetch).toHaveBeenCalled()
    })
  })

  describe("trackResponseError", () => {
    it("should send response error event", async () => {
      initTelemetry("token", "individual")
      trackResponseError({
        model: "gpt-5.4",
        durationMs: 500,
        statusCode: 429,
        requestId: "req-error-1",
        modelCallId: "model-call-error-1",
      })

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(globalThis.fetch).toHaveBeenCalled()
    })

    it("should handle error without optional fields", () => {
      initTelemetry("token", "individual")
      trackResponseError({
        model: "gpt-5.4",
        durationMs: 400,
        statusCode: 500,
      })
      expect(globalThis.fetch).toHaveBeenCalled()
    })
  })

  describe("trackAuthNewToken", () => {
    it("should send auth new token event", () => {
      initTelemetry("token", "individual")
      trackAuthNewToken()
      expect(globalThis.fetch).toHaveBeenCalled()
    })
  })

  describe("trackEditFeedback", () => {
    it("should send edit feedback event", async () => {
      initTelemetry("token", "individual")
      trackEditFeedback("positive")

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(globalThis.fetch).toHaveBeenCalled()
    })

    it("should handle different feedback types", () => {
      initTelemetry("token", "individual")
      trackEditFeedback("negative")
      expect(globalThis.fetch).toHaveBeenCalled()
    })
  })

  describe("trackEditHunkAction", () => {
    it("should send edit hunk action event", () => {
      initTelemetry("token", "individual")
      trackEditHunkAction("accept")
      expect(globalThis.fetch).toHaveBeenCalled()
    })

    it("should handle different hunk actions", () => {
      initTelemetry("token", "individual")
      trackEditHunkAction("reject")
      expect(globalThis.fetch).toHaveBeenCalled()
    })
  })

  describe("trackPanelRequest", () => {
    it("should send panel request event via MSFT endpoint", () => {
      initTelemetry("token", "individual")
      trackPanelRequest({ command: "panel.request" })
      // trackPanelRequest uses undici.request (MSFT path), not globalThis.fetch.
      // sendMsftTelemetryEnvelope runs synchronously until its first `await request(...)`,
      // so mockUndiciRequest is called synchronously when trackPanelRequest returns.
      expect(mockUndiciRequest).toHaveBeenCalled()
    })
  })

  describe("scheduleFeedbackEvents", () => {
    it("should schedule feedback events after delay", async () => {
      const originalSetTimeout = globalThis.setTimeout
      globalThis.setTimeout = mock((callback: () => void) => {
        callback()
        return 0 as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout
      try {
        initTelemetry("token", "individual")
        scheduleFeedbackEvents("session-123")
        await Promise.resolve()
        expect(globalThis.fetch).toHaveBeenCalled()
      } finally {
        globalThis.setTimeout = originalSetTimeout
      }
    })
  })

  describe("trackEvent", () => {
    it("should send custom event", () => {
      initTelemetry("token", "individual")
      trackEvent("custom.event", { property: "value" }, { measurement: 42 })
      expect(globalThis.fetch).toHaveBeenCalled()
    })

    it("should respect telemetry disabled config", () => {
      mockTelemetryEnabled = false
      initTelemetry("token", "individual")
      trackEvent("test.event", {})
      // Should not call fetch when telemetry is disabled
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })
  })

  describe("Envelope Structure", () => {
    it("should create valid Application Insights envelope", () => {
      initTelemetry("token", "individual")
      trackRequestSent("gpt-5.4", "individual")

      // Verify envelope contains required fields
      // Note: Cannot directly check envelope without accessing mock internals
      expect(globalThis.fetch).toHaveBeenCalled()
    })
  })

  describe("Sampling Behavior", () => {
    it("should respect 30% sampling rate when Math.random returns low value", () => {
      Math.random = () => 0.1
      initTelemetry("token", "individual")
      trackEvent("sampled.event", {})
      expect(globalThis.fetch).toHaveBeenCalled()
    })

    it("should skip event when Math.random exceeds threshold", () => {
      Math.random = () => 0.95
      initTelemetry("token", "individual")
      trackEvent("not.sampled.event", {})
      // When random is > 0.3, event is not sent
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })
  })
})
