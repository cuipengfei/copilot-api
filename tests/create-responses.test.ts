/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  test,
  expect,
  mock,
  spyOn,
  beforeEach,
  afterEach,
  describe,
  type Mock,
} from "bun:test"

import type { ResponsesPayload } from "~/lib/types/responses"

import * as autoSession from "../src/lib/auto-session"
import { getAttachedPremiumInfo } from "../src/lib/logger"
import { getAttachedResponseHeaders } from "../src/lib/response-headers"
import {
  copilotHeaders,
  copilotWebSocketHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "../src/lib/api-config"
import { COMPACT_REQUEST } from "../src/lib/compact"
import { state } from "../src/lib/state"
import {
  buildResponsesWebSocketPoolKey,
  buildResponsesWebSocketPayload,
  buildResponsesWebSocketUrl,
  createResponses,
  prepareResponsesWebSocketRequest,
} from "../src/services/copilot/create-responses"
import * as telemetryModule from "../src/services/telemetry/telemetry"

const originalFetch = globalThis.fetch
const originalOauthApp = process.env.COPILOT_API_OAUTH_APP
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  forceAgent: state.forceAgent,
  interactionId: state.interactionId,
  macMachineId: state.macMachineId,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  vsCodeVersion: state.vsCodeVersion,
}

// Telemetry mock (captures modelCallId for assertions)
let capturedModelCallId: string | undefined

// Helper: create non-stream fetch mock
const createFetchMock = () =>
  mock(
    (_url: string, opts: { body?: string; headers: Record<string, string> }) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "resp-123",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "ok" }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
            incomplete_details: null,
            error: null,
          }),
        text: () => Promise.resolve('{"itemsReceived":1,"itemsAccepted":1}'),
        headers: new Headers({
          ...opts.headers,
          "x-quota-snapshot-premium_interactions":
            "ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z",
        }),
      }),
  )

// Helper: create stream fetch mock
const createStreamFetchMock = () =>
  mock(
    (_url: string, opts: { body?: string; headers: Record<string, string> }) =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('{"itemsReceived":1,"itemsAccepted":1}'),
        body: new ReadableStream(),
        headers: new Headers({
          ...opts.headers,
          "x-quota-snapshot-premium_interactions":
            "ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z",
        }),
        [Symbol.asyncIterator]: function* () {},
      }),
  )

// Helper: create error fetch mock
const createErrorFetchMock = (status: number) =>
  mock(() =>
    Promise.resolve({
      ok: false,
      status,
      json: () => Promise.resolve({ error: "upstream error" }),
      text: () => Promise.resolve('{"itemsReceived":0,"itemsAccepted":0}'),
      headers: {},
      clone: function () {
        return this
      },
    }),
  )

let fetchMock: ReturnType<typeof createFetchMock>
let capturedTrackRequestSentRequestId: string | undefined
let capturedScheduleFeedbackRequestId: string | undefined
let capturedSchedulePostResponseRequestId: string | undefined

beforeEach(() => {
  delete process.env.COPILOT_API_OAUTH_APP
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.forceAgent = false
  state.interactionId = "test-interaction-id"
  state.macMachineId = "machine-1"
  state.vsCodeDeviceId = "device-1"
  state.vsCodeSessionId = "session-1"
  state.vsCodeVersion = "1.120.0"
  capturedModelCallId = undefined
  capturedTrackRequestSentRequestId = undefined
  capturedScheduleFeedbackRequestId = undefined
  capturedSchedulePostResponseRequestId = undefined
  fetchMock = createFetchMock()
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

  spyOn(autoSession, "getAutoSessionTokenForModel").mockResolvedValue(
    "test-session-token",
  )

  // Capture modelCallId using spyOn (can be restored by mock.restore())
  spyOn(telemetryModule, "trackRequestSent").mockImplementation(
    (
      _model: string,
      _accountType: string,
      requestId?: string,
      modelCallId?: string,
      // eslint-disable-next-line max-params
    ) => {
      capturedTrackRequestSentRequestId = requestId
      capturedModelCallId = modelCallId
    },
  )
  spyOn(telemetryModule, "trackResponseSuccess").mockImplementation(() => {})
  spyOn(telemetryModule, "trackResponseError").mockImplementation(() => {})
  spyOn(telemetryModule, "trackPanelRequest").mockImplementation(() => {})
  spyOn(telemetryModule, "trackGhostTextShown").mockImplementation(() => {})
  spyOn(telemetryModule, "scheduleFeedbackEvents").mockImplementation(
    (requestId: string) => {
      capturedScheduleFeedbackRequestId = requestId
    },
  )
  spyOn(telemetryModule, "schedulePostResponseEvents").mockImplementation(
    (requestId: string) => {
      capturedSchedulePostResponseRequestId = requestId
    },
  )
})

afterEach(() => {
  mock.restore()
  if (originalOauthApp === undefined) {
    delete process.env.COPILOT_API_OAUTH_APP
  } else {
    process.env.COPILOT_API_OAUTH_APP = originalOauthApp
  }
  state.accountType = originalState.accountType
  state.copilotToken = originalState.copilotToken
  state.forceAgent = originalState.forceAgent
  state.interactionId = originalState.interactionId
  state.macMachineId = originalState.macMachineId
  state.vsCodeDeviceId = originalState.vsCodeDeviceId
  state.vsCodeSessionId = originalState.vsCodeSessionId
  state.vsCodeVersion = originalState.vsCodeVersion
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

// ── X-Initiator tests (原有 3 个测试，保持逻辑不变) ──────────────────────

test("sets X-Initiator to user when initiator is user", async () => {
  const payload = {
    model: "gpt-test",
    input: [{ role: "user" as const, content: "hi" }],
  }
  await createResponses(payload, { vision: false, initiator: "user" })
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["x-initiator"]).toBe("user")
})

test("sets X-Initiator to agent when initiator is agent", async () => {
  const payload = {
    model: "gpt-test",
    input: [{ role: "user" as const, content: "hi" }],
  }
  await createResponses(payload, { vision: false, initiator: "agent" })
  const callIndex = fetchMock.mock.calls.length - 1
  const headers = (
    fetchMock.mock.calls[callIndex][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["x-initiator"]).toBe("agent")
})

test("forces X-Initiator to agent when state.forceAgent is true", async () => {
  state.forceAgent = true
  const payload = {
    model: "gpt-test",
    input: [{ role: "user" as const, content: "hi" }],
  }
  await createResponses(payload, { vision: false, initiator: "user" })
  const callIndex = fetchMock.mock.calls.length - 1
  const headers = (
    fetchMock.mock.calls[callIndex][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["x-initiator"]).toBe("agent")
})

// ── Interaction headers tests ─────────────────────────────────────────────

describe("Interaction headers (Wave 1/2)", () => {
  test("includes X-Interaction-Id from state.interactionId", async () => {
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }
    await createResponses(payload, { vision: false, initiator: "user" })
    const headers = (
      fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    expect(headers["x-interaction-id"]).toBe("test-interaction-id")
  })

  test("X-Agent-Task-Id equals x-request-id", async () => {
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }
    await createResponses(payload, { vision: false, initiator: "user" })
    const headers = (
      fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    expect(headers["x-agent-task-id"]).toBe(headers["x-request-id"])
  })

  test("sets subagent interaction headers for HTTP responses requests", async () => {
    const payload: ResponsesPayload = {
      input: "hello",
      model: "gpt-test",
    }

    await createResponses(payload, {
      initiator: "agent",
      requestId: "request-1",
      sessionId: "interaction-1",
      subagentMarker: {
        agent_id: "agent-1",
        agent_type: "collab_spawn",
        session_id: "sub-session",
      },
      vision: false,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    const requestInit = init as RequestInit & {
      headers: Record<string, string>
    }
    expect(requestInit.headers["x-initiator"]).toBe("agent")
    expect(requestInit.headers["x-interaction-id"]).toBe("interaction-1")
    expect(requestInit.headers["x-interaction-type"]).toBe(
      "conversation-subagent",
    )
  })

  test("X-Interaction-Type equals openai-intent", async () => {
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }
    await createResponses(payload, { vision: false, initiator: "user" })
    const headers = (
      fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    expect(headers["x-interaction-type"]).toBe(headers["openai-intent"])
  })

  test("passes non-empty modelCallId to telemetry", async () => {
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }
    await createResponses(payload, { vision: false, initiator: "user" })
    expect(capturedModelCallId).toBeDefined()
    expect(typeof capturedModelCallId).toBe("string")
    expect(capturedModelCallId!.length).toBeGreaterThan(0)
  })

  test("uses x-request-id header for telemetry/scheduler when requestId option is missing", async () => {
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }

    await createResponses(payload, { vision: false, initiator: "user" })

    const headers = (
      fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers
    const headerRequestId = headers["x-request-id"]

    expect(typeof headerRequestId).toBe("string")
    expect(headerRequestId.length).toBeGreaterThan(0)
    expect(capturedTrackRequestSentRequestId).toBe(headerRequestId)
    expect(capturedScheduleFeedbackRequestId).toBe(headerRequestId)
    expect(capturedSchedulePostResponseRequestId).toBe(headerRequestId)
  })
  test("keeps cache-relevant HTTP payloads deterministic", async () => {
    const payload: ResponsesPayload = {
      input: [
        { role: "user", content: "hello" },
        {
          encrypted_content: "encrypted-reasoning",
          id: "reasoning-1",
          summary: [],
          type: "reasoning",
        },
      ],
      instructions: "stable instructions",
      model: "gpt-test",
      prompt_cache_key: "stable-cache-key",
      stream: false,
    }

    await createResponses(structuredClone(payload), {
      initiator: "user",
      requestId: "request-1",
      vision: false,
    })
    await createResponses(structuredClone(payload), {
      initiator: "user",
      requestId: "request-1",
      vision: false,
    })

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      fetchMock.mock.calls[1]?.[1]?.body,
    )
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain(
      '"prompt_cache_key":"stable-cache-key"',
    )
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain(
      '"encrypted_content":"encrypted-reasoning"',
    )
  })
})

// ── Stream path ───────────────────────────────────────────────────────────

describe("Stream path", () => {
  test("returns stream when payload.stream is true", async () => {
    // @ts-expect-error - Mock fetch doesn't implement all fetch properties
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      createStreamFetchMock()
    const payload = {
      model: "gpt-test",
      stream: true,
      input: [{ role: "user" as const, content: "hi" }],
    }
    const result = await createResponses(payload, {
      vision: false,
      initiator: "user",
    })
    // events() returns an async iterable
    expect(result).toBeDefined()
  })

  test("attaches premium info from response header on stream path", async () => {
    // @ts-expect-error - Mock fetch doesn't implement all fetch properties
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      createStreamFetchMock()
    const payload = {
      model: "gpt-test",
      stream: true,
      input: [{ role: "user" as const, content: "hi" }],
    }

    const result = await createResponses(payload, {
      vision: false,
      initiator: "user",
    })

    expect(getAttachedPremiumInfo(result)).toEqual({
      remaining: 106.5,
      total: 300,
    })
  })

  test("attaches premium info from response header", async () => {
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }

    const result = await createResponses(payload, {
      vision: false,
      initiator: "user",
    })

    expect(getAttachedPremiumInfo(result)).toEqual({
      remaining: 106.5,
      total: 300,
    })
  })

  test("attaches upstream response headers on non-stream path", async () => {
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }

    const result = await createResponses(payload, {
      vision: false,
      initiator: "user",
    })

    expect(
      getAttachedResponseHeaders(result)?.get(
        "x-quota-snapshot-premium_interactions",
      ),
    ).toBe("ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z")
  })

  test("attaches upstream response headers on stream path", async () => {
    // @ts-expect-error - Mock fetch doesn't implement all fetch properties
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      createStreamFetchMock()
    const payload = {
      model: "gpt-test",
      stream: true,
      input: [{ role: "user" as const, content: "hi" }],
    }

    const result = await createResponses(payload, {
      vision: false,
      initiator: "user",
    })

    expect(
      getAttachedResponseHeaders(result)?.get(
        "x-quota-snapshot-premium_interactions",
      ),
    ).toBe("ent=300&ov=0.0&ovPerm=false&rem=35.5&rst=2026-04-01T00%3A00%3A00Z")
  })
})

// ── Error path ────────────────────────────────────────────────────────────

describe("Error path", () => {
  test("throws HTTPError when response is not ok", async () => {
    // @ts-expect-error - Mock fetch doesn't implement all fetch properties
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
      createErrorFetchMock(500)
    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }
    try {
      await createResponses(payload, { vision: false, initiator: "user" })
      expect.unreachable("Should have thrown")
    } catch (error) {
      expect((error as Error).message).toBe("Failed to create responses")
    }
  })
})

// ── Reasoning encrypted_content strip-retry ───────────────────────────────

const BELONG_ERROR_BODY =
  '{"error":{"message":"input item ID does not belong to this connection","code":""}}'

type TestFetchImpl = (
  url: string,
  opts: { headers: Record<string, string>; body?: string },
) => Promise<unknown>

const createErrorFetchMockWithBody = (
  status: number,
  body: string,
): Mock<TestFetchImpl> =>
  mock((_url: string, _opts: { headers: Record<string, string> }) =>
    Promise.resolve({
      ok: false,
      status,
      json: () => Promise.resolve({ error: "upstream error" }),
      text: () => Promise.resolve(body),
      headers: new Headers(),
      clone: function () {
        return this
      },
    }),
  )

const createBelongThenSuccessFetchMock = (): Mock<TestFetchImpl> => {
  let call = 0
  return mock((_url: string, _opts: { headers: Record<string, string> }) => {
    call += 1
    if (call === 1) {
      return Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: "upstream error" }),
        text: () => Promise.resolve(BELONG_ERROR_BODY),
        headers: new Headers(),
        clone: function () {
          return this
        },
      })
    }
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "resp-retry",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
          incomplete_details: null,
          error: null,
        }),
      text: () => Promise.resolve('{"itemsReceived":1,"itemsAccepted":1}'),
      headers: new Headers(),
    })
  })
}

describe("Reasoning strip-retry on belong 4xx", () => {
  const reasoningPayload = (): ResponsesPayload => ({
    model: "gpt-test",
    input: [
      { role: "user", content: "hi" },
      {
        type: "reasoning",
        id: "r-1",
        summary: [],
        encrypted_content: "enc-abc",
      },
      { role: "user", content: "next" },
    ],
  })

  const setFetch = (fetchImpl: Mock<TestFetchImpl>) => {
    // @ts-expect-error - Mock fetch doesn't implement all fetch properties
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchImpl
  }

  const getRequestReasoningItem = (
    fetchImpl: Mock<TestFetchImpl>,
    callIndex: number,
  ) => {
    const rawBody = fetchImpl.mock.calls[callIndex][1]?.body
    if (rawBody === undefined) {
      throw new Error(`request body missing on fetch call ${callIndex}`)
    }
    const body = JSON.parse(rawBody) as {
      input: Array<Record<string, unknown>>
    }
    return body.input.find((item) => item.type === "reasoning")
  }

  test("sends encrypted_content first, retries once with it stripped when 4xx mentions belong", async () => {
    const belongMock = createBelongThenSuccessFetchMock()
    setFetch(belongMock)

    const result = await createResponses(reasoningPayload(), {
      vision: false,
      initiator: "user",
    })

    expect(belongMock).toHaveBeenCalledTimes(2)
    expect(getRequestReasoningItem(belongMock, 0)).toMatchObject({
      encrypted_content: "enc-abc",
    })
    const retryReasoning = getRequestReasoningItem(belongMock, 1)
    expect(retryReasoning).toMatchObject({
      id: "r-1",
      summary: [],
      type: "reasoning",
    })
    expect(retryReasoning?.encrypted_content).toBeUndefined()
    expect(result).toMatchObject({ id: "resp-retry" })
  })

  test("does not retry when the error body has no belong marker", async () => {
    const noBelongMock = createErrorFetchMockWithBody(
      401,
      "unauthorized: AuthenticateToken authentication failed",
    )
    setFetch(noBelongMock)

    try {
      await createResponses(reasoningPayload(), {
        vision: false,
        initiator: "user",
      })
      expect.unreachable("Should have thrown")
    } catch (error) {
      expect((error as Error).message).toBe("Failed to create responses")
    }
    expect(noBelongMock).toHaveBeenCalledTimes(1)
  })
  test("does not retry when belong appears outside error.message", async () => {
    const unrelatedBelongMock = createErrorFetchMockWithBody(
      401,
      '{"error":{"message":"input item validation failed","detail":"item does not belong to this connection"}}',
    )
    setFetch(unrelatedBelongMock)

    try {
      await createResponses(reasoningPayload(), {
        vision: false,
        initiator: "user",
      })
      expect.unreachable("Should have thrown")
    } catch (error) {
      expect((error as Error).message).toBe("Failed to create responses")
    }
    expect(unrelatedBelongMock).toHaveBeenCalledTimes(1)
  })

  test("does not retry when payload has no strippable reasoning item", async () => {
    const belongMock = createErrorFetchMockWithBody(401, BELONG_ERROR_BODY)
    setFetch(belongMock)

    const payload = {
      model: "gpt-test",
      input: [{ role: "user" as const, content: "hi" }],
    }
    try {
      await createResponses(payload, { vision: false, initiator: "user" })
      expect.unreachable("Should have thrown")
    } catch (error) {
      expect((error as Error).message).toBe("Failed to create responses")
    }
    expect(belongMock).toHaveBeenCalledTimes(1)
  })

  test("does not retry on non-4xx even when the body mentions belong", async () => {
    const serverErrorMock = createErrorFetchMockWithBody(500, BELONG_ERROR_BODY)
    setFetch(serverErrorMock)

    try {
      await createResponses(reasoningPayload(), {
        vision: false,
        initiator: "user",
      })
      expect.unreachable("Should have thrown")
    } catch (error) {
      expect((error as Error).message).toBe("Failed to create responses")
    }
    expect(serverErrorMock).toHaveBeenCalledTimes(1)
  })

  test("does not loop when the retry also fails", async () => {
    const alwaysBelongMock = createErrorFetchMockWithBody(
      401,
      BELONG_ERROR_BODY,
    )
    setFetch(alwaysBelongMock)

    try {
      await createResponses(reasoningPayload(), {
        vision: false,
        initiator: "user",
      })
      expect.unreachable("Should have thrown")
    } catch (error) {
      expect((error as Error).message).toBe("Failed to create responses")
    }
    expect(alwaysBelongMock).toHaveBeenCalledTimes(2)
  })
})

test("uses HTTP when websocket transport is requested without stream=true", async () => {
  const payload: ResponsesPayload = {
    input: "hello",
    model: "gpt-test",
    stream: false,
  }

  const response = await createResponses(payload, {
    initiator: "user",
    requestId: "request-1",
    transport: "websocket",
    vision: false,
  })

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(response).toMatchObject({
    error: null,
    id: "resp-123",
    incomplete_details: null,
    output: [
      {
        content: [{ text: "ok", type: "output_text" }],
        role: "assistant",
        type: "message",
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  })
})

describe("createResponses websocket helpers", () => {
  test("builds the first websocket frame as response.create", () => {
    const payload = {
      background: true,
      input: "hello",
      model: "gpt-test",
      service_tier: "auto",
      stream: true,
    } as ResponsesPayload

    const websocketPayload = buildResponsesWebSocketPayload(payload, "agent")

    expect(websocketPayload).toEqual({
      initiator: "agent",
      input: "hello",
      model: "gpt-test",
      type: "response.create",
    })
    expect("stream" in websocketPayload).toBe(false)
    expect("background" in websocketPayload).toBe(false)
    expect("service_tier" in websocketPayload).toBe(false)
  })

  test("builds websocket URLs from the Copilot base URL", () => {
    expect(buildResponsesWebSocketUrl("https://api.githubcopilot.com")).toBe(
      "wss://api.githubcopilot.com/responses",
    )
    expect(buildResponsesWebSocketUrl("http://localhost:3000/")).toBe(
      "ws://localhost:3000/responses",
    )
  })

  test("builds capture-style websocket headers without x-initiator", () => {
    const preparedHeaders = {
      ...copilotHeaders(state, "request-1", true),
      "x-initiator": "user",
    }
    prepareInteractionHeaders("interaction-1", false, preparedHeaders)

    const headers = copilotWebSocketHeaders(preparedHeaders)

    expect(headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Copilot-Integration-Id": "vscode-chat",
      "Copilot-Vision-Request": "true",
      "Editor-Device-Id": "device-1",
      "Editor-Plugin-Version": "copilot-chat/0.67.0",
      "Editor-Version": "vscode/1.120.0",
      "OpenAI-Intent": "conversation-agent",
      "VScode-SessionId": "session-1",
      "VScode-MachineId": "machine-1",
      "X-Agent-Task-Id": "request-1",
      "X-GitHub-Api-Version": "2026-08-01",
      "X-Interaction-Id": "interaction-1",
      "X-Interaction-Type": "conversation-agent",
      "X-Request-Id": "request-1",
      "user-agent": "node",
    })
    const headerNames = Object.keys(headers)
    const agentTaskIdIndex = headerNames.indexOf("X-Agent-Task-Id")
    expect(
      headerNames.slice(agentTaskIdIndex + 1, agentTaskIdIndex + 3),
    ).toEqual(["VScode-SessionId", "VScode-MachineId"])
    expect(headerNames[headerNames.length - 1]).toBe("user-agent")
    expect(headers.accept).toBeUndefined()
    expect(headers["accept-encoding"]).toBeUndefined()
    expect(headers["accept-language"]).toBeUndefined()
    expect(headers["cache-control"]).toBeUndefined()
    expect(headers.pragma).toBeUndefined()
    expect(headers["sec-fetch-mode"]).toBeUndefined()
    expect(headers["x-initiator"]).toBeUndefined()
    expect(headers["sec-websocket-key"]).toBeUndefined()
  })

  test("websocket request uses prepared compact and interaction headers", () => {
    const preparedHeaders = {
      ...copilotHeaders(state, "request-1", false),
      "x-initiator": "user",
    }
    prepareInteractionHeaders("interaction-1", true, preparedHeaders)
    prepareForCompact(preparedHeaders, COMPACT_REQUEST)

    const request = prepareResponsesWebSocketRequest(
      {
        input: "hello",
        model: "gpt-test",
        stream: true,
      },
      preparedHeaders,
      {
        requestId: "request-1",
        subagentMarker: {
          agent_id: "agent-1",
          agent_type: "Explore",
          session_id: "sub-session",
        },
      },
    )

    expect(request.payload).toMatchObject({
      initiator: "agent",
      input: "hello",
      model: "gpt-test",
      type: "response.create",
    })
    expect(request.headers["OpenAI-Intent"]).toBe("conversation-agent")
    expect(request.headers["X-Interaction-Id"]).toBe("interaction-1")
    expect(request.headers["X-Interaction-Type"]).toBe(
      "conversation-compaction",
    )
    expect(request.headers["x-initiator"]).toBeUndefined()
  })

  test("websocket request keeps opencode headers and moves x-initiator into body", () => {
    process.env.COPILOT_API_OAUTH_APP = "opencode"

    const preparedHeaders = {
      ...copilotHeaders(state, "request-1", false),
      "x-initiator": "user",
    }
    prepareInteractionHeaders("interaction-1", true, preparedHeaders)
    prepareForCompact(preparedHeaders, COMPACT_REQUEST)

    const request = prepareResponsesWebSocketRequest(
      {
        input: "hello",
        model: "gpt-test",
        stream: true,
      },
      preparedHeaders,
      {
        requestId: "request-1",
      },
    )

    expect(request.payload.initiator).toBe("agent")
    expect(request.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Openai-Intent": "conversation-edits",
    })
    expect(request.headers["User-Agent"]).toStartWith("opencode/")
    expect(request.headers["x-initiator"]).toBeUndefined()
    expect(request.headers["X-Request-Id"]).toBeUndefined()
    expect(request.headers["x-interaction-id"]).toBeUndefined()
  })

  test("websocket pool key separates model request and subagent context", () => {
    const basePayload: ResponsesPayload = {
      input: "hello",
      model: "gpt-test",
    }
    const mainKey = buildResponsesWebSocketPoolKey(basePayload, {
      requestId: "request-1",
    })
    const subagentKey = buildResponsesWebSocketPoolKey(basePayload, {
      requestId: "request-1",
      subagentMarker: {
        agent_id: "agent-1",
        agent_type: "Explore",
        session_id: "sub-session",
      },
    })
    const otherModelKey = buildResponsesWebSocketPoolKey(
      {
        ...basePayload,
        model: "gpt-other",
      },
      {
        requestId: "request-1",
      },
    )

    expect(new Set([mainKey, subagentKey, otherModelKey]).size).toBe(3)
    expect(mainKey).toContain("gpt-test")
    expect(mainKey).toContain("request-1")
  })
})
