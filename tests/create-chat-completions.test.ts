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
import type { Model } from "~/lib/types/models"
import type { ResponsesPayload } from "~/lib/types/responses"

import * as autoSession from "../src/lib/auto-session"
import * as configModule from "../src/lib/config"
import { getAttachedResponseHeaders } from "../src/lib/response-headers"
import { state } from "../src/lib/state"
import { translateToOpenAI } from "../src/routes/messages/completions-translation"
import { translateResponsesToChatCompletions } from "../src/routes/responses/responses-from-chat"
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
        return Promise.resolve(Response.json(usageResponse.data))
      }
      return Promise.resolve(new Response(null, { status: 500 }))
    }

    // Chat completions call
    return Promise.resolve(
      Response.json({ id: "123", object: "chat.completion", choices: [] }),
    )
  })
}

describe("Interaction headers", () => {
  beforeEach(() => {
    fetchCalls = []
    state.interactionId = "test-interaction-id"
    state.forceAgent = false
    trackPanelRequestCalls = 0
    trackGhostTextShownCalls = 0

    spyOn(autoSession, "getAutoSessionForModel").mockResolvedValue({
      sessionToken: "test-session-token",
      source: "auto",
      expectedDiscount: 10,
    })
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
        return Promise.resolve(
          Response.json(
            { error: { message: "upstream failed" } },
            { status: 500 },
          ),
        )
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

    spyOn(autoSession, "getAutoSessionForModel").mockResolvedValue({
      sessionToken: "test-session-token",
      source: "auto",
      expectedDiscount: 10,
    })
    spyOn(telemetryModule, "trackRequestSent").mockImplementation((options) => {
      capturedModelCallIdFromRequestSent = options.modelCallId
    })
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
    const stream = await createChatCompletions(payload)
    for await (const _chunk of stream as AsyncIterable<unknown>) {
      void _chunk
    }

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
              { status: 400, headers: { "X-Request-Id": "first-attempt-id" } },
            ),
          )
        }
        return Promise.resolve(
          Response.json(
            { error: "retry also failed" },
            { status: 500, headers: { "X-Request-Id": "final-attempt-id" } },
          ),
        )
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
    expect(capturedErrorOpts!.requestId).toBe("final-attempt-id")
  })

  test("normal error passes modelCallId to trackResponseError", async () => {
    // @ts-expect-error - Mock fetch
    globalThis.fetch = mock(
      (url: string, opts: { headers: Record<string, string> }) => {
        fetchCalls.push({ url, headers: opts.headers })
        if (url.includes("copilot_internal")) {
          return Promise.resolve({ ok: false, status: 500 })
        }
        return Promise.resolve(
          Response.json({ error: "service unavailable" }, { status: 503 }),
        )
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

    spyOn(autoSession, "getAutoSessionForModel").mockResolvedValue({
      sessionToken: "test-session-token",
      source: "auto",
      expectedDiscount: 10,
    })
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

describe("default reasoning effort injection", () => {
  let upstreamBodies: Array<Record<string, unknown>> = []
  let originalModels = state.models

  const createModel = (
    id: string,
    reasoningEffort?: Array<string>,
    family = "gpt",
  ): Model => ({
    capabilities: {
      family,
      limits: {},
      object: "model_capabilities",
      supports:
        reasoningEffort === undefined ?
          {}
        : { reasoning_effort: reasoningEffort },
      tokenizer: "o200k_base",
      type: "chat",
    },
    id,
    model_picker_enabled: true,
    name: id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: "1",
  })

  // Captures the JSON body actually sent upstream; only fetch is faked.
  const installUpstreamFetch = (): void => {
    upstreamBodies = []
    globalThis.fetch = mock((url: string, opts: { body?: string }) => {
      if (url.includes("copilot_internal")) {
        return Promise.resolve({ ok: false, status: 500 })
      }
      upstreamBodies.push(
        JSON.parse(opts.body ?? "{}") as Record<string, unknown>,
      )
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: "123", object: "chat.completion", choices: [] }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch
  }

  beforeEach(() => {
    originalModels = state.models
    state.models = {
      object: "list",
      data: [
        createModel("gpt-5.4", ["low", "medium", "high", "xhigh"]),
        createModel("gpt-5.4-limited", ["low", "medium", "high"]),
        createModel("gpt-test"),
        createModel("no-effort-model", []),
        createModel("metadata-gemini", undefined, "GeMiNi"),
        createModel("opaque-model", undefined, "GeMiNi"),
        createModel("versioned-family-model", undefined, "Gemini-3-Pro"),
        createModel("gemini-3-pro", undefined, "gpt"),
        {
          id: "gpt-minimal-metadata",
          capabilities: { limits: {} },
        } as unknown as Model,
      ],
    }
    state.interactionId = "test-interaction-id"
    state.forceAgent = false

    spyOn(configModule, "getReasoningEffortForModel").mockImplementation(
      (model) =>
        model === "gpt-5.4-limited" ? "xhigh"
        : model === "gpt-5.4" ? "medium"
        : "high",
    )
    spyOn(autoSession, "getAutoSessionForModel").mockResolvedValue({
      sessionToken: "test-session-token",
      source: "auto",
      expectedDiscount: 10,
    })
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
    state.models = originalModels
    mock.restore()
  })

  test("non-stream request without effort sends the configured model effort", async () => {
    installUpstreamFetch()

    await createChatCompletions({
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-5.4",
    })

    expect(upstreamBodies).toHaveLength(1)
    expect(upstreamBodies[0].reasoning_effort).toBe("medium")
  })

  test("explicit request effort is sent unchanged", async () => {
    installUpstreamFetch()

    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-5.4",
      reasoning_effort: "minimal",
    }
    await createChatCompletions(payload)

    expect(upstreamBodies[0].reasoning_effort).toBe("minimal")
    expect(payload.reasoning_effort).toBe("minimal")
  })

  test("stream request without effort also sends the configured effort", async () => {
    installUpstreamFetch()

    await createChatCompletions({
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-test",
      stream: true,
    })

    expect(upstreamBodies[0]).toMatchObject({
      reasoning_effort: "high",
      stream: true,
    })
  })

  test("model advertising no efforts gets none injected", async () => {
    installUpstreamFetch()

    await createChatCompletions({
      messages: [{ role: "user", content: "hi" }],
      model: "no-effort-model",
    })

    expect(upstreamBodies[0]).not.toHaveProperty("reasoning_effort")
  })

  test("configured effort is clamped to the model supported efforts", async () => {
    installUpstreamFetch()

    await createChatCompletions({
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-5.4-limited",
    })

    expect(upstreamBodies[0].reasoning_effort).toBe("high")
  })

  test("Messages to Chat translation still gets the configured effort at send time", async () => {
    installUpstreamFetch()

    const translated = translateToOpenAI(
      {
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
        model: "gpt-test",
      },
      { validateReasoningEffort: true },
    )
    expect(translated).not.toHaveProperty("reasoning_effort")

    await createChatCompletions(translated)

    expect(upstreamBodies[0].reasoning_effort).toBe("high")
  })

  test("Responses to Chat translation keeps request effort and defaults missing effort", async () => {
    installUpstreamFetch()

    const withoutEffort: ResponsesPayload = { input: "hi", model: "gpt-5.4" }
    await createChatCompletions(
      translateResponsesToChatCompletions(withoutEffort),
    )
    expect(upstreamBodies[0].reasoning_effort).toBe("medium")

    upstreamBodies = []
    const withEffort: ResponsesPayload = {
      input: "hi",
      model: "gpt-5.4",
      reasoning: { effort: "low" },
    }
    await createChatCompletions(translateResponsesToChatCompletions(withEffort))
    expect(upstreamBodies[0].reasoning_effort).toBe("low")
  })

  test("metadata without effort capabilities keeps the request usable", async () => {
    installUpstreamFetch()

    await createChatCompletions({
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-minimal-metadata",
      temperature: 0.4,
    })

    expect(upstreamBodies[0]).toMatchObject({
      model: "gpt-minimal-metadata",
      reasoning_effort: "high",
      temperature: 0.4,
    })
  })

  test("signature retry keeps the injected config effort", async () => {
    spyOn(autoSession, "getAutoSessionForModel").mockResolvedValue(undefined)
    const thinkingError = new Response(
      JSON.stringify({ error: { message: "signature invalid" } }),
      { status: 400 },
    )
    let chatCalls = 0
    upstreamBodies = []
    globalThis.fetch = mock((url: string, opts: { body?: string }) => {
      if (url.includes("copilot_internal")) {
        return Promise.resolve({ ok: false, status: 500 })
      }
      chatCalls += 1
      upstreamBodies.push(
        JSON.parse(opts.body ?? "{}") as Record<string, unknown>,
      )
      if (chatCalls === 1) return Promise.resolve(thinkingError)
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: "123", object: "chat.completion", choices: [] }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    await createChatCompletions({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "ok",
          reasoning_opaque: "sig",
          reasoning_text: "old thought",
        },
        { role: "user", content: "again" },
      ],
      model: "gpt-5.4",
      temperature: 0.3,
    })

    expect(chatCalls).toBe(2)
    const firstMessages = upstreamBodies[0].messages as Array<
      Record<string, unknown>
    >
    expect(upstreamBodies[0]).toMatchObject({
      model: "gpt-5.4",
      reasoning_effort: "medium",
      temperature: 0.3,
    })
    expect(firstMessages).toHaveLength(3)
    expect(firstMessages[1]).toMatchObject({
      content: "ok",
      reasoning_opaque: "sig",
      reasoning_text: "old thought",
      role: "assistant",
    })

    expect(upstreamBodies[1]).toMatchObject({
      model: "gpt-5.4",
      reasoning_effort: "medium",
      temperature: 0.3,
    })
    const retriedMessages = upstreamBodies[1].messages as Array<
      Record<string, unknown>
    >
    expect(retriedMessages).toHaveLength(3)
    expect(retriedMessages[0]).toEqual({ content: "hi", role: "user" })
    expect(retriedMessages[1]).toEqual({ content: "ok", role: "assistant" })
    expect(retriedMessages[2]).toEqual({ content: "again", role: "user" })
  })

  test("applies cache markers to an opaque model id from case-insensitive Gemini family metadata", async () => {
    installUpstreamFetch()

    await createChatCompletions({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "latest" },
      ],
      model: "opaque-model",
    })

    expect(upstreamBodies[0].messages).toEqual([
      {
        role: "system",
        content: "system",
        copilot_cache_control: { type: "ephemeral" },
      },
      {
        role: "user",
        content: "latest",
        copilot_cache_control: { type: "ephemeral" },
      },
    ])
  })

  test("matches versioned Gemini family metadata", async () => {
    installUpstreamFetch()

    await createChatCompletions({
      messages: [{ role: "user", content: "hello" }],
      model: "versioned-family-model",
    })

    expect(upstreamBodies[0].messages).toEqual([
      {
        role: "user",
        content: "hello",
        copilot_cache_control: { type: "ephemeral" },
      },
    ])
  })

  test("does not use a Gemini-like id when metadata has a non-Gemini family", async () => {
    installUpstreamFetch()

    await createChatCompletions({
      messages: [{ role: "user", content: "hello" }],
      model: "gemini-3-pro",
    })

    expect(upstreamBodies[0].messages).toEqual([
      { role: "user", content: "hello" },
    ])
  })

  test("selects four markers in reverse order while preserving message and tool fields", async () => {
    installUpstreamFetch()

    const payload: ChatCompletionsPayload = {
      model: "metadata-gemini",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: "first answer",
          reasoning_text: "thought",
        },
        { role: "user", content: "second" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "result", tool_call_id: "call_1" },
        { role: "user", content: "third" },
        { role: "assistant", content: "final", reasoning_opaque: "signature" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "look up",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      reasoning_effort: "low",
      tool_choice: "auto",
    }
    await createChatCompletions(payload)

    expect(upstreamBodies[0].messages).toEqual([
      {
        role: "system",
        content: "system",
        copilot_cache_control: { type: "ephemeral" },
      },
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: "first answer",
        reasoning_text: "thought",
        copilot_cache_control: { type: "ephemeral" },
      },
      { role: "user", content: "second" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "result", tool_call_id: "call_1" },
      {
        role: "user",
        content: "third",
        copilot_cache_control: { type: "ephemeral" },
      },
      {
        role: "assistant",
        content: "final",
        reasoning_opaque: "signature",
        copilot_cache_control: { type: "ephemeral" },
      },
    ])
    expect(upstreamBodies[0]).toMatchObject({
      model: "metadata-gemini",
      reasoning_effort: "low",
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "look up",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    })
  })

  test("counts an existing marker on a non-candidate toward the budget", async () => {
    installUpstreamFetch()

    await createChatCompletions({
      model: "metadata-gemini",
      messages: [
        { role: "user", content: "one" },
        { role: "user", content: "two" },
        {
          role: "tool",
          content: "result",
          tool_call_id: "call_1",
          copilot_cache_control: { type: "ephemeral" },
        },
        { role: "user", content: "three" },
        { role: "user", content: "four" },
      ],
    })

    expect(upstreamBodies[0].messages).toEqual([
      {
        role: "user",
        content: "one",
        copilot_cache_control: { type: "ephemeral" },
      },
      {
        role: "user",
        content: "two",
        copilot_cache_control: { type: "ephemeral" },
      },
      {
        role: "tool",
        content: "result",
        tool_call_id: "call_1",
        copilot_cache_control: { type: "ephemeral" },
      },
      { role: "user", content: "three" },
      {
        role: "user",
        content: "four",
        copilot_cache_control: { type: "ephemeral" },
      },
    ])
  })

  test("four and five existing markers prevent additions", async () => {
    installUpstreamFetch()

    const fourMessages: ChatCompletionsPayload["messages"] = [
      {
        role: "tool",
        content: "result 0",
        tool_call_id: "call_0",
        copilot_cache_control: { type: "ephemeral" },
      },
      {
        role: "tool",
        content: "result 1",
        tool_call_id: "call_1",
        copilot_cache_control: { type: "ephemeral" },
      },
      {
        role: "tool",
        content: "result 2",
        tool_call_id: "call_2",
        copilot_cache_control: { type: "ephemeral" },
      },
      {
        role: "tool",
        content: "result 3",
        tool_call_id: "call_3",
        copilot_cache_control: { type: "ephemeral" },
      },
      { role: "assistant", content: "unmarked" },
    ]
    const fiveMessages: ChatCompletionsPayload["messages"] = [
      {
        role: "tool",
        content: "result 0",
        tool_call_id: "call_0",
        copilot_cache_control: { type: "ephemeral" },
      },
      {
        role: "tool",
        content: "result 1",
        tool_call_id: "call_1",
        copilot_cache_control: { type: "ephemeral" },
      },
      {
        role: "tool",
        content: "result 2",
        tool_call_id: "call_2",
        copilot_cache_control: { type: "ephemeral" },
      },
      {
        role: "tool",
        content: "result 3",
        tool_call_id: "call_3",
        copilot_cache_control: { type: "ephemeral" },
      },
      {
        role: "tool",
        content: "result 4",
        tool_call_id: "call_4",
        copilot_cache_control: { type: "ephemeral" },
      },
      { role: "assistant", content: "unmarked" },
    ]
    await createChatCompletions({
      model: "metadata-gemini",
      messages: structuredClone(fourMessages),
    })
    await createChatCompletions({
      model: "metadata-gemini",
      messages: structuredClone(fiveMessages),
    })
    expect(upstreamBodies[0].messages).toEqual(fourMessages)
    expect(upstreamBodies[1].messages).toEqual(fiveMessages)
  })

  test("reapplying to the same object and replaying JSON are idempotent", async () => {
    installUpstreamFetch()

    const payload: ChatCompletionsPayload = {
      model: "metadata-gemini",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "one" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "two" },
        { role: "user", content: "three" },
      ],
    }
    await createChatCompletions(payload)
    await createChatCompletions(payload)
    await createChatCompletions(
      JSON.parse(JSON.stringify(upstreamBodies[0])) as ChatCompletionsPayload,
    )

    const expectedMessages = [
      {
        role: "system",
        content: "system",
        copilot_cache_control: { type: "ephemeral" },
      },
      {
        role: "user",
        content: "one",
        copilot_cache_control: { type: "ephemeral" },
      },
      {
        role: "assistant",
        content: "answer",
        copilot_cache_control: { type: "ephemeral" },
      },
      { role: "user", content: "two" },
      {
        role: "user",
        content: "three",
        copilot_cache_control: { type: "ephemeral" },
      },
    ]
    expect(upstreamBodies).toHaveLength(3)
    expect(upstreamBodies[0].messages).toEqual(expectedMessages)
    expect(upstreamBodies[1].messages).toEqual(expectedMessages)
    expect(upstreamBodies[2].messages).toEqual(expectedMessages)
  })

  test("does not add cache markers for non-Gemini family metadata", async () => {
    installUpstreamFetch()

    await createChatCompletions({
      messages: [{ role: "user", content: "hello" }],
      model: "gpt-test",
    })

    expect(upstreamBodies[0].messages).toEqual([
      { role: "user", content: "hello" },
    ])
  })

  test("does not infer cache eligibility from a Gemini-like model id without metadata", async () => {
    installUpstreamFetch()

    await createChatCompletions({
      messages: [{ role: "user", content: "hello" }],
      model: "gemini-unlisted",
    })

    expect(upstreamBodies[0].messages).toEqual([
      { role: "user", content: "hello" },
    ])
  })
})
