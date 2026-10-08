import {
  test,
  expect,
  mock,
  beforeEach,
  afterEach,
  describe,
  spyOn,
} from "bun:test"

import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"

import * as autoSession from "../src/lib/auto-session"
import { getAttachedResponseHeaders } from "../src/lib/response-headers"
import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"
import * as telemetryModule from "../src/services/telemetry/telemetry"

/* eslint-disable @typescript-eslint/no-non-null-assertion */

// Mock state
state.copilotToken = "test-token"
state.githubToken = "test-github-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Track calls for assertions
let fetchCalls: Array<{ url: string; headers: Record<string, string> }> = []
let trackPanelRequestCalls = 0
let trackGhostTextShownCalls = 0

// Helper to mock fetch - handles both usage API and chat completions
const createFetchMock = (usageResponse?: {
  ok: boolean
  data?: {
    quota_snapshots: {
      premium_interactions: { entitlement: number; remaining: number }
    }
    quota_reset_date: string
  }
}) => {
  return mock((url: string, opts: { headers: Record<string, string> }) => {
    fetchCalls.push({ url, headers: opts.headers })

    // Usage API call
    if (url.includes("copilot_internal/user")) {
      if (usageResponse?.ok) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(usageResponse.data),
        })
      }
      return Promise.resolve({ ok: false, status: 500 })
    }

    // Chat completions call
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({ id: "123", object: "chat.completion", choices: [] }),
    })
  })
}

describe("Interaction headers", () => {
  beforeEach(() => {
    fetchCalls = []
    state.interactionId = "test-interaction-id"
    state.forceAgent = false
    trackPanelRequestCalls = 0
    trackGhostTextShownCalls = 0

    spyOn(autoSession, "getAutoSessionTokenForModel").mockResolvedValue(
      "test-session-token",
    )
    spyOn(telemetryModule, "trackRequestSent").mockImplementation(() => {})
    spyOn(telemetryModule, "trackResponseSuccess").mockImplementation(() => {})
    spyOn(telemetryModule, "trackResponseError").mockImplementation(() => {})
    spyOn(telemetryModule, "scheduleFeedbackEvents").mockImplementation(
      () => {},
    )
    spyOn(telemetryModule, "trackPanelRequest").mockImplementation(() => {
      trackPanelRequestCalls += 1
    })
    spyOn(telemetryModule, "trackGhostTextShown").mockImplementation(() => {
      trackGhostTextShownCalls += 1
    })
  })

  afterEach(() => {
    mock.restore()
  })

  test("includes x-interaction-id from state.interactionId", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = createFetchMock()

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }
    await createChatCompletions(payload)

    const chatCall = fetchCalls.find((c) => c.url.includes("chat/completions"))
    expect(chatCall).toBeDefined()
    expect(chatCall!.headers["x-interaction-id"]).toBe("test-interaction-id")
  })

  test("emits panel and ghost telemetry after signature-retry success", async () => {
    const signatureError = new Response(
      JSON.stringify({ error: { message: "signature cannot be modified" } }),
      { status: 400 },
    )
    const successResponse = {
      ok: true,
      headers: new Headers({
        "x-quota-snapshot-premium_interactions":
          "ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z",
      }),
      json: () =>
        Promise.resolve({
          id: "123",
          object: "chat.completion",
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
    }

    // @ts-expect-error - Mock fetch
    globalThis.fetch = mock(
      (url: string, opts: { headers: Record<string, string> }) => {
        fetchCalls.push({ url, headers: opts.headers })

        const completionCalls = fetchCalls.filter((call) =>
          call.url.includes("chat/completions"),
        )
        return Promise.resolve(
          completionCalls.length === 1 ? signatureError : successResponse,
        )
      },
    )

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }

    await createChatCompletions(payload)

    expect(trackPanelRequestCalls).toBe(1)
    expect(trackGhostTextShownCalls).toBe(1)
    expect(
      fetchCalls.filter((call) => call.url.includes("chat/completions")).length,
    ).toBe(2)
  })

  test("does not emit panel and ghost telemetry on non-retry error", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = mock(
      (url: string, opts: { headers: Record<string, string> }) => {
        fetchCalls.push({ url, headers: opts.headers })
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () =>
            Promise.resolve({ error: { message: "upstream failed" } }),
          clone() {
            return this
          },
        })
      },
    )

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }

    try {
      await createChatCompletions(payload)
      expect.unreachable("Should have thrown")
    } catch (error) {
      expect((error as Error).message).toBe("Failed to create chat completions")
    }

    expect(trackPanelRequestCalls).toBe(0)
    expect(trackGhostTextShownCalls).toBe(0)
  })

  test("attaches premium info from response header without usage api call", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = mock(
      (url: string, opts: { headers: Record<string, string> }) => {
        fetchCalls.push({ url, headers: opts.headers })
        return Promise.resolve({
          ok: true,
          headers: new Headers({
            "x-quota-snapshot-premium_interactions":
              "ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z",
          }),
          json: () =>
            Promise.resolve({
              id: "123",
              object: "chat.completion",
              choices: [],
            }),
        })
      },
    )

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }
    const result = await createChatCompletions(payload)

    expect(
      fetchCalls.every((call) => !call.url.includes("copilot_internal/user")),
    ).toBe(true)
    expect((result as { id: string }).id).toBe("123")
    expect(
      getAttachedResponseHeaders(result)?.get(
        "x-quota-snapshot-premium_interactions",
      ),
    ).toBe("ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z")
  })
})

describe("modelCallId telemetry alignment", () => {
  let capturedModelCallIdFromRequestSent: string | undefined
  let capturedSuccessOpts:
    telemetryModule.TrackResponseSuccessOptions | undefined
  let capturedErrorOpts: telemetryModule.TrackResponseErrorOptions | undefined
  let schedulePostResponseEventsCallCount: number

  beforeEach(() => {
    fetchCalls = []
    capturedModelCallIdFromRequestSent = undefined
    capturedSuccessOpts = undefined
    capturedErrorOpts = undefined
    schedulePostResponseEventsCallCount = 0
    trackPanelRequestCalls = 0
    trackGhostTextShownCalls = 0
    state.interactionId = "test-interaction-id"
    state.forceAgent = false

    spyOn(autoSession, "getAutoSessionTokenForModel").mockResolvedValue(
      "test-session-token",
    )
    spyOn(telemetryModule, "trackRequestSent").mockImplementation(
      (...args: Parameters<typeof telemetryModule.trackRequestSent>) => {
        capturedModelCallIdFromRequestSent = args[3]
      },
    )
    spyOn(telemetryModule, "trackResponseSuccess").mockImplementation(
      (opts) => {
        capturedSuccessOpts = opts
      },
    )
    spyOn(telemetryModule, "trackResponseError").mockImplementation((opts) => {
      capturedErrorOpts = opts
    })
    spyOn(telemetryModule, "scheduleFeedbackEvents").mockImplementation(
      () => {},
    )
    spyOn(telemetryModule, "schedulePostResponseEvents").mockImplementation(
      () => {
        schedulePostResponseEventsCallCount += 1
      },
    )
    spyOn(telemetryModule, "trackPanelRequest").mockImplementation(() => {
      trackPanelRequestCalls += 1
    })
    spyOn(telemetryModule, "trackGhostTextShown").mockImplementation(() => {
      trackGhostTextShownCalls += 1
    })
  })

  afterEach(() => {
    mock.restore()
  })

  test("non-stream success passes modelCallId to trackResponseSuccess", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = createFetchMock()

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }
    await createChatCompletions(payload)

    expect(capturedModelCallIdFromRequestSent).toBeDefined()
    expect(typeof capturedModelCallIdFromRequestSent).toBe("string")
    expect(capturedSuccessOpts).toBeDefined()
    expect(capturedSuccessOpts!.modelCallId).toBe(
      capturedModelCallIdFromRequestSent,
    )
  })

  test("non-stream success calls schedulePostResponseEvents", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = createFetchMock()

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }
    await createChatCompletions(payload)

    expect(schedulePostResponseEventsCallCount).toBe(1)
  })

  test("stream success passes modelCallId to trackResponseSuccess", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = mock(
      (url: string, opts: { headers: Record<string, string> }) => {
        fetchCalls.push({ url, headers: opts.headers })
        if (url.includes("copilot_internal")) {
          return Promise.resolve({ ok: false, status: 500 })
        }
        return Promise.resolve({
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.close()
            },
          }),
        })
      },
    )

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
      stream: true,
    }
    await createChatCompletions(payload)

    expect(capturedModelCallIdFromRequestSent).toBeDefined()
    expect(capturedSuccessOpts).toBeDefined()
    expect(capturedSuccessOpts!.modelCallId).toBe(
      capturedModelCallIdFromRequestSent,
    )
  })

  test("retry failure passes modelCallId to trackResponseError", async () => {
    let chatCallCount = 0
    // @ts-expect-error - Mock fetch
    globalThis.fetch = mock(
      (url: string, opts: { headers: Record<string, string> }) => {
        fetchCalls.push({ url, headers: opts.headers })
        if (url.includes("copilot_internal")) {
          return Promise.resolve({ ok: false, status: 500 })
        }
        chatCallCount++
        if (chatCallCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: { message: "signature cannot be modified" },
              }),
              { status: 400 },
            ),
          )
        }
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: "retry also failed" }),
          clone() {
            return this
          },
        })
      },
    )

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }
    try {
      await createChatCompletions(payload)
      expect.unreachable("Should have thrown")
    } catch {
      // expected to throw
    }

    expect(capturedModelCallIdFromRequestSent).toBeDefined()
    expect(capturedErrorOpts).toBeDefined()
    expect(capturedErrorOpts!.modelCallId).toBe(
      capturedModelCallIdFromRequestSent,
    )
  })

  test("normal error passes modelCallId to trackResponseError", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = mock(
      (url: string, opts: { headers: Record<string, string> }) => {
        fetchCalls.push({ url, headers: opts.headers })
        if (url.includes("copilot_internal")) {
          return Promise.resolve({ ok: false, status: 500 })
        }
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ error: "service unavailable" }),
          clone() {
            return this
          },
        })
      },
    )

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
    }
    try {
      await createChatCompletions(payload)
      expect.unreachable("Should have thrown")
    } catch {
      // expected to throw
    }

    expect(capturedModelCallIdFromRequestSent).toBeDefined()
    expect(capturedErrorOpts).toBeDefined()
    expect(capturedErrorOpts!.modelCallId).toBe(
      capturedModelCallIdFromRequestSent,
    )
  })
})

describe("Initiator detection (last-message role)", () => {
  beforeEach(() => {
    fetchCalls = []
    state.interactionId = "test-interaction-id"
    state.forceAgent = false

    spyOn(autoSession, "getAutoSessionTokenForModel").mockResolvedValue(
      "test-session-token",
    )
    spyOn(telemetryModule, "trackRequestSent").mockImplementation(() => {})
    spyOn(telemetryModule, "trackResponseSuccess").mockImplementation(() => {})
    spyOn(telemetryModule, "trackResponseError").mockImplementation(() => {})
    spyOn(telemetryModule, "scheduleFeedbackEvents").mockImplementation(
      () => {},
    )
    spyOn(telemetryModule, "schedulePostResponseEvents").mockImplementation(
      () => {},
    )
    spyOn(telemetryModule, "trackPanelRequest").mockImplementation(() => {})
    spyOn(telemetryModule, "trackGhostTextShown").mockImplementation(() => {})
  })

  afterEach(() => {
    mock.restore()
  })

  test("sets x-initiator to agent if tool/assistant present at end", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = createFetchMock()

    const payload: ChatCompletionsPayload = {
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", content: "tool call", tool_call_id: "call_1" },
      ],
      model: "gpt-test",
    }
    await createChatCompletions(payload, { requestId: "1" })

    const chatCall = fetchCalls.find((c) => c.url.includes("chat/completions"))
    expect(chatCall).toBeDefined()
    expect(chatCall!.headers["x-initiator"]).toBe("agent")
  })

  test("sets x-initiator to user if only user messages present", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = createFetchMock()

    const payload: ChatCompletionsPayload = {
      messages: [
        { role: "user", content: "hi" },
        { role: "user", content: "hello again" },
      ],
      model: "gpt-test",
    }
    await createChatCompletions(payload, { requestId: "1" })

    const chatCall = fetchCalls.find((c) => c.url.includes("chat/completions"))
    expect(chatCall).toBeDefined()
    expect(chatCall!.headers["x-initiator"]).toBe("user")
  })
})
