import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import { createProbeCondition } from "../src/lib/auto-probe-prompts"
import { rejects } from "node:assert/strict"

import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"
import type { ResponsesPayload } from "~/lib/types/responses"

import {
  invalidateAutoSession,
  prewarmAutoSession,
  registerAutoSelection,
  registerFusionSelection,
  resumeAutoSessionDiscoveryAfterRotation,
  stopProbeScheduler,
  whenProbeSchedulerIdle,
} from "../src/lib/auto-session"
import { getConfig } from "../src/lib/config-store"
import { HTTPError } from "../src/lib/error"
import { state } from "../src/lib/state"
import { attachAutoSessionToken } from "../src/services/copilot/auto-session-retry"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"
import { createMessages } from "../src/services/copilot/create-messages"
import { createResponses } from "../src/services/copilot/create-responses"
import type { AutoSelectionResponse } from "../src/services/copilot/get-auto-selection"

const originalGithubToken = state.githubToken
const originalTelemetryEnabled = state.copilotTelemetryEnabled
const originalAutoDiscovery = getConfig().autoDiscovery
const originalFetch = globalThis.fetch
const originalState = {
  copilotApiUrl: state.copilotApiUrl,
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
  accountType: state.accountType,
  forceAgent: state.forceAgent,
  models: state.models,
  interactionId: state.interactionId,
}
const createMessagesPayload: AnthropicMessagesPayload = {
  model: "gpt-5.3-codex",
  max_tokens: 256,
  messages: [{ role: "user", content: "hello" }],
}

const createChatPayload: ChatCompletionsPayload = {
  model: "gpt-5.3-codex",
  messages: [{ role: "user", content: "hello" }],
}

const createResponsesPayload: ResponsesPayload = {
  model: "gpt-5.3-codex",
  input: [{ role: "user", content: "hello" }],
}

const createAutoSelectionResponse = (payload: AutoSelectionResponse) =>
  new Response(JSON.stringify(payload), { status: 200 })

const queuedAutoSelection = (
  modelId: string,
  sessionToken: string,
  supportedEndpoints: Array<string>,
): AutoSelectionResponse => ({
  selected_model: { id: modelId, supported_endpoints: supportedEndpoints },
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  session_token: sessionToken,
})

const wireFetchMock = (finalResponseFactory: () => Response) => {
  const REQUEST_CAP = 32
  let requestCount = 0
  const fetchMock = mock((url: string, init?: RequestInit) => {
    requestCount += 1
    if (requestCount > REQUEST_CAP) {
      return Promise.reject(new Error("chain request cap exceeded"))
    }
    const path = new URL(url).pathname
    if (path === "/model/fusion") {
      return Promise.resolve(
        Response.json(
          { error: { code: "model_pool_not_eligible" } },
          { status: 403 },
        ),
      )
    }
    if (path === "/auto") {
      const currentQueue = (
        globalThis as unknown as {
          __AUTO_SESSION_QUEUE__?: Array<AutoSelectionResponse>
        }
      ).__AUTO_SESSION_QUEUE__
      const nextPayload = currentQueue?.shift()
      if (!nextPayload)
        return Promise.resolve(new Response(null, { status: 400 }))
      return Promise.resolve(createAutoSelectionResponse(nextPayload))
    }

    if (
      url.includes("/v1/messages")
      || url.includes("/chat/completions")
      || url.includes("/responses")
    ) {
      const finalCalls = (
        globalThis as unknown as {
          __AUTO_SESSION_FINAL_CALLS__?: Array<[string, RequestInit]>
        }
      ).__AUTO_SESSION_FINAL_CALLS__
      finalCalls?.push([
        url,
        {
          ...init,
          headers: { ...(init?.headers as Record<string, string>) },
        },
      ])
      return Promise.resolve(finalResponseFactory())
    }

    // 未知 URL 立即失败：fail-fast，避免回归导致请求洪泛
    return Promise.reject(new Error(`unexpected request url: ${url}`))
  })

  // @ts-expect-error Bun mock is enough for runtime; typed fetch extras are not required in test
  ;(globalThis as { fetch: typeof fetch }).fetch = fetchMock
  return fetchMock
}

const findCall = (
  fetchMock: ReturnType<typeof mock>,
  pathKeyword: string,
): [string, RequestInit] => {
  const matchedCall = fetchMock.mock.calls.find((call) =>
    (call[0] as string).includes(pathKeyword),
  )
  expect(matchedCall).toBeDefined()
  return matchedCall as [string, RequestInit]
}

const getSessionHeader = (init: RequestInit): string | undefined => {
  const headers = init.headers as Record<string, string>
  return headers["Copilot-Session-Token"]
}

const requestBodyText = (init: RequestInit): string => {
  if (typeof init.body !== "string") {
    throw new Error("expected string request body")
  }
  return init.body
}

const getFinalCallSnapshots = (
  pathKeyword: string,
): Array<[string, RequestInit]> =>
  (
    (
      globalThis as unknown as {
        __AUTO_SESSION_FINAL_CALLS__?: Array<[string, RequestInit]>
      }
    ).__AUTO_SESSION_FINAL_CALLS__ ?? []
  ).filter(([url]) => url.includes(pathKeyword))

const createOpaqueTokenRejection = (status: number) =>
  status === 400 ?
    Response.json(
      {
        error: {
          code: "invalid_session_token",
          message: "Copilot session token is invalid",
        },
      },
      { status },
    )
  : new Response("opaque upstream failure without any known keyword", {
      status,
    })

const queueStaleAuto = (endpoint: string): void => {
  const queue = Reflect.get(
    globalThis,
    "__AUTO_SESSION_QUEUE__",
  ) as Array<AutoSelectionResponse>
  queue.push(queuedAutoSelection("gpt-5.3-codex", "session-stale", [endpoint]))
}

const countAutoCalls = (fetchMock: ReturnType<typeof mock>): number =>
  fetchMock.mock.calls.filter((call) => String(call[0]).includes("/auto"))
    .length

const createResponsesSuccess = (id: string) =>
  new Response(
    JSON.stringify({
      id,
      object: "response",
      created_at: Date.now(),
      model: "gpt-5.3-codex",
      output: [],
      output_text: "",
      status: "completed",
      usage: null,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      parallel_tool_calls: false,
      temperature: null,
      tool_choice: null,
      tools: [],
      top_p: null,
    }),
    { status: 200 },
  )

const createChatSuccess = (id: string) =>
  new Response(
    JSON.stringify({
      id,
      object: "chat.completion",
      choices: [],
    }),
    { status: 200 },
  )

const createMessagesSuccess = (id: string) =>
  new Response(JSON.stringify({ id }), { status: 200 })

beforeEach(() => {
  invalidateAutoSession()
  getConfig().autoDiscovery = undefined
  const queue: Array<AutoSelectionResponse> = []
  ;(
    globalThis as unknown as {
      __AUTO_SESSION_FINAL_CALLS__?: Array<[string, RequestInit]>
      __AUTO_SESSION_QUEUE__?: typeof queue
    }
  ).__AUTO_SESSION_QUEUE__ = queue
  ;(
    globalThis as unknown as {
      __AUTO_SESSION_FINAL_CALLS__?: Array<[string, RequestInit]>
    }
  ).__AUTO_SESSION_FINAL_CALLS__ = []

  state.copilotToken = "test-copilot-token"
  state.copilotApiUrl = undefined
  state.copilotTelemetryEnabled = false
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.forceAgent = false
  state.models = {
    object: "list",
    data: [
      {
        id: "gpt-5.3-codex",
        capabilities: {
          family: "gpt-5.3-codex",
          limits: {},
          object: "capabilities",
          supports: {
            adaptive_thinking: false,
            tool_calls: true,
            streaming: true,
          },
          tokenizer: "o200k_base",
          type: "chat",
        },
        model_picker_enabled: true,
        name: "GPT-5.3-Codex",
        object: "model",
        preview: false,
        vendor: "OpenAI",
        version: "1",
        supported_endpoints: [
          "/responses",
          "ws:/responses",
          "/chat/completions",
          "/v1/messages",
        ],
      },
    ],
  }
  state.interactionId = "test-interaction-id"
})

afterEach(async () => {
  await whenProbeSchedulerIdle()
  globalThis.fetch = originalFetch
  Object.assign(state, originalState)
  state.githubToken = originalGithubToken
  state.copilotTelemetryEnabled = originalTelemetryEnabled
  invalidateAutoSession()
  getConfig().autoDiscovery = originalAutoDiscovery
  mock.restore()
})

afterAll(async () => {
  stopProbeScheduler()
  await whenProbeSchedulerIdle()
})

describe("auto-session token injection across chains", () => {
  test.each([
    undefined,
    { user_id: "user_device_account_account_session_session" },
  ])(
    "messages chain preserves paired session token with metadata %j",
    async (metadata) => {
      ;(
        globalThis as unknown as {
          __AUTO_SESSION_QUEUE__: Array<AutoSelectionResponse>
        }
      ).__AUTO_SESSION_QUEUE__.push(
        queuedAutoSelection("gpt-5.3-codex", "session-hit", ["/v1/messages"]),
      )

      const fetchMock = wireFetchMock(
        () => new Response(JSON.stringify({ id: "msg-1" }), { status: 200 }),
      )

      await prewarmAutoSession()
      state.githubToken = "test-github-token"
      await createMessages({ ...createMessagesPayload, metadata }, undefined, {
        initiator: "user",
      })

      const [url, init] = findCall(fetchMock, "/v1/messages")
      expect(getSessionHeader(init)).toBe("session-hit")
      expect(new URL(url).pathname).toBe("/v1/messages")
      const headers = new Headers(init.headers)
      expect(headers.get("Authorization")).toBe(
        metadata ? "Bearer test-github-token" : "Bearer test-copilot-token",
      )
      if (metadata) expect(headers.get("OpenAI-Intent")).toBe("messages-proxy")

      const parsedBody: unknown = JSON.parse(requestBodyText(init))
      if (
        typeof parsedBody !== "object"
        || parsedBody === null
        || !("model" in parsedBody)
      ) {
        throw new Error("inference request body missing model")
      }
      expect(parsedBody.model).toBe("gpt-5.3-codex")
      expect(parsedBody).toMatchObject({
        messages: createMessagesPayload.messages,
        ...(metadata ? { metadata } : {}),
      })
    },
  )

  test("messages proxy preserves GitHub authorization and metadata through Auto rejection", async () => {
    state.githubToken = "test-github-token"
    expect(
      registerAutoSelection(
        queuedAutoSelection("gpt-5.3-codex", "proxy-auto-token", [
          "/v1/messages",
        ]),
        createProbeCondition({
          source: "auto",
          tier: "balance",
          prompt: "hello",
        }),
      ),
    ).toBe(true)
    let attempts = 0
    wireFetchMock(() =>
      ++attempts === 1 ?
        createOpaqueTokenRejection(401)
      : createMessagesSuccess("proxy-full-price"),
    )
    const metadata = { user_id: "user_device_account_account_session_session" }

    expect(
      await createMessages({ ...createMessagesPayload, metadata }, undefined, {
        initiator: "user",
      }),
    ).toMatchObject({ id: "proxy-full-price" })

    const calls = getFinalCallSnapshots("/v1/messages")
    expect(calls.map(([, init]) => getSessionHeader(init))).toEqual([
      "proxy-auto-token",
      undefined,
    ])
    const firstBody: unknown = JSON.parse(requestBodyText(calls[0][1]))
    expect(firstBody).toMatchObject({
      model: createMessagesPayload.model,
      messages: createMessagesPayload.messages,
      metadata,
    })
    const firstHeaders = new Headers(calls[0][1].headers)
    for (const [url, init] of calls) {
      expect(new URL(url).pathname).toBe("/v1/messages")
      const headers = new Headers(init.headers)
      expect(headers.get("Authorization")).toBe("Bearer test-github-token")
      expect(headers.get("OpenAI-Intent")).toBe("messages-proxy")
      expect(headers.get("X-Request-Id")).toBe(firstHeaders.get("X-Request-Id"))
      expect(JSON.parse(requestBodyText(init))).toEqual(firstBody)
    }
  })

  test.each([false, true])(
    "messages proxy selection waiting for discovery cannot cross GitHub rotation with Copilot rotation=%s",
    async (rotateCopilot) => {
      const initialCopilotToken = state.copilotToken
      state.githubToken = "test-github-token"
      getConfig().autoDiscovery = { models: ["gpt-5.3-codex"] }
      const release = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      const fetchMock = wireFetchMock(() =>
        createMessagesSuccess("proxy-after-rotation"),
      )
      const gatedFetch = mock(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : input.toString()
          if (new URL(url).pathname === "/auto") {
            started.resolve()
            await release.promise
          }
          return fetchMock(url, init)
        },
      )
      globalThis.fetch = gatedFetch as unknown as typeof fetch
      const startup = prewarmAutoSession()

      try {
        await started.promise
        const headers = { Authorization: "Bearer test-github-token" }
        const attachment = attachAutoSessionToken(
          headers,
          "gpt-5.3-codex",
          "/v1/messages",
        )
        let completed = false
        void attachment.then(() => {
          completed = true
        })
        // Drain the attachment's immediate await continuation, without advancing the discovery clock.
        await Promise.resolve()
        await Promise.resolve()
        expect(completed).toBe(false)
        state.githubToken = "rotated-github-token"
        if (rotateCopilot) {
          state.copilotToken = "rotated-copilot-token"
          invalidateAutoSession()
        }
        expect(
          registerAutoSelection(
            queuedAutoSelection("gpt-5.3-codex", "auto-after-rotation", [
              "/v1/messages",
            ]),
            createProbeCondition({
              source: "auto",
              tier: "balance",
              prompt: "hello",
            }),
          ),
        ).toBe(true)

        await attachment
        expect(headers).toEqual({ Authorization: "Bearer test-github-token" })
      } finally {
        getConfig().autoDiscovery = undefined
        resumeAutoSessionDiscoveryAfterRotation()
        release.resolve()
        await startup
        await whenProbeSchedulerIdle()
        state.copilotToken = initialCopilotToken
        invalidateAutoSession()
        resumeAutoSessionDiscoveryAfterRotation()
        await whenProbeSchedulerIdle()
      }
    },
  )

  test("messages chain keeps old path when model is not covered", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<AutoSelectionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedAutoSelection("other-model", "session-miss", ["/v1/messages"]),
    )

    const fetchMock = wireFetchMock(
      () => new Response(JSON.stringify({ id: "msg-2" }), { status: 200 }),
    )

    await prewarmAutoSession()
    await createMessages(createMessagesPayload, undefined, {
      initiator: "user",
    })

    const [, init] = findCall(fetchMock, "/v1/messages")
    const headers = init.headers as Record<string, string>
    expect(getSessionHeader(init)).toBeUndefined()
    expect(headers["x-initiator"]).toBe("user")
  })

  test("chat-completions chain adds Copilot-Session-Token when model is covered", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<AutoSelectionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedAutoSelection("gpt-5.3-codex", "session-hit", [
        "/chat/completions",
      ]),
    )

    const fetchMock = wireFetchMock(
      () =>
        new Response(
          JSON.stringify({
            id: "chat-1",
            object: "chat.completion",
            choices: [],
          }),
          { status: 200 },
        ),
    )

    await prewarmAutoSession()
    await createChatCompletions(createChatPayload)

    const [, init] = findCall(fetchMock, "/chat/completions")
    expect(getSessionHeader(init)).toBe("session-hit")

    const parsedBody: unknown = JSON.parse(requestBodyText(init))
    if (
      typeof parsedBody !== "object"
      || parsedBody === null
      || !("model" in parsedBody)
    ) {
      throw new Error("inference request body missing model")
    }
    expect(parsedBody.model).toBe("gpt-5.3-codex")
  })

  test("chat-completions chain keeps old path when model is not covered", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<AutoSelectionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedAutoSelection("other-model", "session-miss", ["/chat/completions"]),
    )

    const fetchMock = wireFetchMock(
      () =>
        new Response(
          JSON.stringify({
            id: "chat-2",
            object: "chat.completion",
            choices: [],
          }),
          { status: 200 },
        ),
    )

    await prewarmAutoSession()
    const result = (await createChatCompletions(createChatPayload)) as {
      id: string
    }

    const [, init] = findCall(fetchMock, "/chat/completions")
    expect(getSessionHeader(init)).toBeUndefined()
    expect(result.id).toBe("chat-2")
  })

  test("responses chain adds Copilot-Session-Token when model is covered", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<AutoSelectionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedAutoSelection("gpt-5.3-codex", "session-hit", [
        "/responses",
        "ws:/responses",
      ]),
    )

    const fetchMock = wireFetchMock(
      () =>
        new Response(
          JSON.stringify({
            id: "resp-1",
            object: "response",
            created_at: Date.now(),
            model: "gpt-5.3-codex",
            output: [],
            output_text: "",
            status: "completed",
            usage: null,
            error: null,
            incomplete_details: null,
            instructions: null,
            metadata: null,
            parallel_tool_calls: false,
            temperature: null,
            tool_choice: null,
            tools: [],
            top_p: null,
          }),
          { status: 200 },
        ),
    )

    await prewarmAutoSession()
    await createResponses(createResponsesPayload, {
      vision: false,
      initiator: "user",
    })

    const [, init] = findCall(fetchMock, "/responses")
    expect(getSessionHeader(init)).toBe("session-hit")

    const parsedBody: unknown = JSON.parse(requestBodyText(init))
    if (
      typeof parsedBody !== "object"
      || parsedBody === null
      || !("model" in parsedBody)
    ) {
      throw new Error("inference request body missing model")
    }
    expect(parsedBody.model).toBe("gpt-5.3-codex")
  })

  test("responses chain keeps old path when model is not covered", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<AutoSelectionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedAutoSelection("other-model", "session-miss", ["/responses"]),
    )

    const fetchMock = wireFetchMock(
      () =>
        new Response(
          JSON.stringify({
            id: "resp-2",
            object: "response",
            created_at: Date.now(),
            model: "gpt-5.3-codex",
            output: [],
            output_text: "",
            status: "completed",
            usage: null,
            error: null,
            incomplete_details: null,
            instructions: null,
            metadata: null,
            parallel_tool_calls: false,
            temperature: null,
            tool_choice: null,
            tools: [],
            top_p: null,
          }),
          { status: 200 },
        ),
    )

    await prewarmAutoSession()
    const result = (await createResponses(createResponsesPayload, {
      vision: false,
      initiator: "user",
    })) as { id: string }

    const [, init] = findCall(fetchMock, "/responses")
    expect(getSessionHeader(init)).toBeUndefined()
    expect(result.id).toBe("resp-2")
  })

  test("responses chain does not attach token when pairing lacks the endpoint", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<AutoSelectionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedAutoSelection("gpt-5.3-codex", "session-other-endpoint", [
        "/chat/completions",
      ]),
    )

    const fetchMock = wireFetchMock(
      () =>
        new Response(
          JSON.stringify({
            id: "resp-endpoint-miss",
            object: "response",
            created_at: Date.now(),
            model: "gpt-5.3-codex",
            output: [],
            output_text: "",
            status: "completed",
            usage: null,
            error: null,
            incomplete_details: null,
            instructions: null,
            metadata: null,
            parallel_tool_calls: false,
            temperature: null,
            tool_choice: null,
            tools: [],
            top_p: null,
          }),
          { status: 200 },
        ),
    )

    await prewarmAutoSession()
    const result = (await createResponses(createResponsesPayload, {
      vision: false,
      initiator: "user",
    })) as { id: string }

    const [, init] = findCall(fetchMock, "/responses")
    expect(getSessionHeader(init)).toBeUndefined()
    expect(result.id).toBe("resp-endpoint-miss")
  })

  test("/auto probe uses POST with exact { prompt, tier } body and model-access identity headers", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<AutoSelectionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedAutoSelection("gpt-5.3-codex", "session-probe", ["/responses"]),
    )

    const fetchMock = wireFetchMock(() => createResponsesSuccess("resp-probe"))

    await prewarmAutoSession()

    expect(countAutoCalls(fetchMock)).toBe(8)
    const probeCall = fetchMock.mock.calls.find(
      (call) =>
        (call[1] as RequestInit).body
        === JSON.stringify({ prompt: "hello", tier: "balance" }),
    )
    const [url, init] = probeCall as unknown as [string, RequestInit]
    expect(String(url)).toBe("https://api.githubcopilot.com/auto")
    expect(init.method).toBe("POST")
    // 请求体恰好 { prompt, tier }：多一个字段都应是红灯
    expect(init.body).toBe(JSON.stringify({ prompt: "hello", tier: "balance" }))

    const headers = init.headers as Record<string, string>
    expect(headers["content-type"]).toBe("application/json")
    expect(headers["Authorization"]).toBe("Bearer test-copilot-token")
    expect(headers["x-github-api-version"]).toBe("2026-08-01")
    expect(headers["openai-intent"]).toBe("model-access")
    expect(headers["x-interaction-type"]).toBe("model-access")
  })

  test("responses belong error keeps session token and replays without encrypted content", async () => {
    queueStaleAuto("/responses")
    let attempts = 0
    const fetchMock = wireFetchMock(() => {
      attempts += 1
      return attempts === 1 ?
          Response.json(
            {
              error: {
                message: "input item does not BeLoNg to this connection",
              },
            },
            { status: 401 },
          )
        : createResponsesSuccess("resp-replayed")
    })
    await prewarmAutoSession()
    const autoBefore = countAutoCalls(fetchMock)
    const payload: ResponsesPayload = {
      ...createResponsesPayload,
      input: [
        { role: "user", content: "hello" },
        {
          type: "reasoning",
          id: "r-1",
          summary: [],
          encrypted_content: "enc-abc",
        },
      ],
    }

    const result: unknown = await createResponses(payload, {
      vision: false,
      initiator: "user",
    })
    if (!result || typeof result !== "object" || !("id" in result)) {
      throw new Error("expected Responses result with id")
    }

    const calls = getFinalCallSnapshots("/responses")
    expect(result.id).toBe("resp-replayed")
    expect(calls).toHaveLength(2)
    expect(countAutoCalls(fetchMock)).toBe(autoBefore)
    expect(getSessionHeader(calls[0][1])).toBe("session-stale")
    expect(getSessionHeader(calls[1][1])).toBe("session-stale")
    const replayedBody: unknown = JSON.parse(requestBodyText(calls[1][1]))
    if (
      typeof replayedBody !== "object"
      || replayedBody === null
      || !("input" in replayedBody)
      || !Array.isArray(replayedBody.input)
    ) {
      throw new Error("expected response input array")
    }
    expect(replayedBody.input).toContainEqual({
      id: "r-1",
      type: "reasoning",
      summary: [],
    })
    expect(requestBodyText(calls[1][1])).not.toContain("encrypted_content")
  })

  test.each([400, 401])(
    "Responses rejects Fusion then Auto then sends no token (%i)",
    async (status) => {
      expect(
        registerAutoSelection(
          queuedAutoSelection("gpt-5.3-codex", "auto-fallback", ["/responses"]),
          createProbeCondition({
            source: "auto",
            tier: "balance",
            prompt: "hello",
          }),
        ),
      ).toBe(true)
      expect(
        registerFusionSelection(
          {
            planVersion: "2" as const,
            fusionPattern: "solo",
            steps: [{ modelId: "gpt-5.3-codex" }],
            sessionToken: "fusion-first",
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
          createProbeCondition({
            source: "fusion",
            planVersion: "2",
            fusionMode: "hydrafusion",
            prompt: "hello",
          }),
        ),
      ).toBe(true)
      let attempts = 0
      wireFetchMock(() =>
        ++attempts < 3 ?
          createOpaqueTokenRejection(status)
        : createResponsesSuccess("resp-full-price"),
      )

      const result = await createResponses(createResponsesPayload, {
        vision: false,
        initiator: "user",
      })
      expect(result).toMatchObject({ id: "resp-full-price" })
      const calls = getFinalCallSnapshots("/responses")
      expect(calls.map(([, init]) => getSessionHeader(init))).toEqual([
        "fusion-first",
        "auto-fallback",
        undefined,
      ])
      const firstBody: unknown = JSON.parse(requestBodyText(calls[0][1]))
      expect(firstBody).toMatchObject({
        model: createResponsesPayload.model,
        input: createResponsesPayload.input,
      })
      for (const [, init] of calls) {
        expect(JSON.parse(requestBodyText(init))).toEqual(firstBody)
      }
      const headers = calls.map(([, init]) => new Headers(init.headers))
      for (const name of [
        "authorization",
        "x-request-id",
        "x-interaction-id",
        "x-initiator",
      ]) {
        expect(headers[1].get(name)).toBe(headers[0].get(name))
        expect(headers[2].get(name)).toBe(headers[0].get(name))
      }
    },
  )

  test("final no-token generation failure remains the actual HTTPError", async () => {
    registerAutoSelection(
      queuedAutoSelection("gpt-5.3-codex", "auto-rejected", ["/responses"]),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )
    registerFusionSelection(
      {
        planVersion: "2" as const,
        fusionPattern: "solo",
        steps: [{ modelId: "gpt-5.3-codex" }],
        sessionToken: "fusion-rejected",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      createProbeCondition({
        source: "fusion",
        planVersion: "2",
        fusionMode: "hydrafusion",
        prompt: "hello",
      }),
    )
    let attempts = 0
    wireFetchMock(() =>
      ++attempts < 3 ?
        createOpaqueTokenRejection(401)
      : new Response("full-price failure", { status: 503 }),
    )
    try {
      await createResponses(createResponsesPayload, {
        vision: false,
        initiator: "user",
      })
      expect.unreachable("Expected final generation failure")
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
      if (!(error instanceof HTTPError)) throw error
      expect(error.response.status).toBe(503)
      expect(await error.response.clone().text()).toBe("full-price failure")
    }
    expect(
      getFinalCallSnapshots("/responses").map(([, init]) =>
        getSessionHeader(init),
      ),
    ).toEqual(["fusion-rejected", "auto-rejected", undefined])
  })

  test.each(["responses", "chat", "messages"] as const)(
    "%s Auto rejection skips the used source despite background reacquisition failure",
    async (chain) => {
      const endpoint =
        chain === "responses" ? "/responses"
        : chain === "chat" ? "/chat/completions"
        : "/v1/messages"
      let attempts = 0
      const fetchMock = wireFetchMock(() => {
        if (++attempts === 1) return createOpaqueTokenRejection(401)
        if (chain === "responses") return createResponsesSuccess("resp-retried")
        if (chain === "chat") return createChatSuccess("chat-retried")
        return createMessagesSuccess("msg-retried")
      })
      await prewarmAutoSession()
      registerAutoSelection(
        queuedAutoSelection("gpt-5.3-codex", "session-stale", [endpoint]),
        createProbeCondition({
          source: "auto",
          tier: "balance",
          prompt: "hello",
        }),
      )
      const probesBeforeRequest = countAutoCalls(fetchMock)

      if (chain === "responses") {
        expect(
          await createResponses(createResponsesPayload, {
            vision: false,
            initiator: "user",
          }),
        ).toMatchObject({ id: "resp-retried" })
      } else if (chain === "chat") {
        expect(await createChatCompletions(createChatPayload)).toMatchObject({
          id: "chat-retried",
        })
      } else {
        expect(
          await createMessages(createMessagesPayload, undefined, {
            initiator: "user",
          }),
        ).toMatchObject({ id: "msg-retried" })
      }
      const calls = getFinalCallSnapshots(endpoint)
      expect(calls.map(([, init]) => getSessionHeader(init))).toEqual([
        "session-stale",
        undefined,
      ])
      for (const [, init] of calls) {
        const body = JSON.parse(requestBodyText(init)) as { model: unknown }
        expect(body.model).toBe("gpt-5.3-codex")
      }
      await whenProbeSchedulerIdle()
      expect(countAutoCalls(fetchMock)).toBeGreaterThan(probesBeforeRequest)
    },
  )

  test.each(["responses", "chat", "messages"] as const)(
    "%s preserves persistent no-token rejection without another discount replay",
    async (chain) => {
      const endpoint =
        chain === "responses" ? "/responses"
        : chain === "chat" ? "/chat/completions"
        : "/v1/messages"
      registerAutoSelection(
        queuedAutoSelection("gpt-5.3-codex", "session-stale", [endpoint]),
        createProbeCondition({
          source: "auto",
          tier: "balance",
          prompt: "hello",
        }),
      )
      wireFetchMock(() => createOpaqueTokenRejection(400))
      try {
        if (chain === "responses")
          await createResponses(createResponsesPayload, {
            vision: false,
            initiator: "user",
          })
        else if (chain === "chat")
          await createChatCompletions(createChatPayload)
        else
          await createMessages(createMessagesPayload, undefined, {
            initiator: "user",
          })
        expect.unreachable("Expected final no-token rejection")
      } catch (error) {
        expect(error).toBeInstanceOf(HTTPError)
        if (!(error instanceof HTTPError)) throw error
        expect(error.response.status).toBe(400)
      }
      expect(
        getFinalCallSnapshots(endpoint).map(([, init]) =>
          getSessionHeader(init),
        ),
      ).toEqual(["session-stale", undefined])
    },
  )

  test("Responses without any pairing sends one failing request and never probes", async () => {
    const fetchMock = wireFetchMock(() => createOpaqueTokenRejection(401))
    await rejects(
      createResponses(createResponsesPayload, {
        vision: false,
        initiator: "user",
      }),
      HTTPError,
    )
    expect(getFinalCallSnapshots("/responses")).toHaveLength(1)
    expect(
      getSessionHeader(getFinalCallSnapshots("/responses")[0][1]),
    ).toBeUndefined()
    expect(countAutoCalls(fetchMock)).toBe(0)
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/model/fusion"),
      ),
    ).toHaveLength(0)
  })

  test.each([
    { forceAgent: false, expectedInitiator: "user" },
    { forceAgent: true, expectedInitiator: "agent" },
  ])(
    "chat fallback preserves forceAgent=$forceAgent initiator",
    async ({ forceAgent, expectedInitiator }) => {
      const previousDecision = state.smartAgentDecision
      const previousCacheTimestamp = state.smartAgentCacheTimestamp
      state.forceAgent = forceAgent
      if (forceAgent) {
        state.smartAgentDecision = {
          forceAgent: true,
          reason: "over_budget",
          remaining: 0,
          expected: 1,
          idealDaily: 1,
        }
        state.smartAgentCacheTimestamp = Date.now()
      }
      try {
        registerAutoSelection(
          queuedAutoSelection("gpt-5.3-codex", "session-stale", [
            "/chat/completions",
          ]),
          createProbeCondition({
            source: "auto",
            tier: "balance",
            prompt: "hello",
          }),
        )
        let attempts = 0
        const fetchMock = wireFetchMock(() =>
          ++attempts === 1 ?
            createOpaqueTokenRejection(401)
          : createChatSuccess("chat-force-agent"),
        )
        expect(await createChatCompletions(createChatPayload)).toMatchObject({
          id: "chat-force-agent",
        })
        const calls = getFinalCallSnapshots("/chat/completions")
        expect(calls.map(([, init]) => getSessionHeader(init))).toEqual([
          "session-stale",
          undefined,
        ])
        for (const [, init] of calls) {
          expect(new Headers(init.headers).get("x-initiator")).toBe(
            expectedInitiator,
          )
          const body = JSON.parse(requestBodyText(init)) as { model: unknown }
          expect(body.model).toBe("gpt-5.3-codex")
        }
        expect(
          fetchMock.mock.calls.filter(([url]) =>
            String(url).includes("copilot_internal/user"),
          ),
        ).toHaveLength(0)
      } finally {
        state.smartAgentDecision = previousDecision
        state.smartAgentCacheTimestamp = previousCacheTimestamp
      }
    },
  )

  test("reasoning replay learns the actual fallback token, not rejected Fusion", async () => {
    registerAutoSelection(
      queuedAutoSelection("gpt-5.3-codex", "auto-current", ["/responses"]),
      createProbeCondition({
        source: "auto",
        tier: "balance",
        prompt: "hello",
      }),
    )
    registerFusionSelection(
      {
        planVersion: "2" as const,
        fusionPattern: "solo",
        steps: [{ modelId: "gpt-5.3-codex" }],
        sessionToken: "fusion-stale",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      createProbeCondition({
        source: "fusion",
        planVersion: "2",
        fusionMode: "hydrafusion",
        prompt: "hello",
      }),
    )
    let attempts = 0
    wireFetchMock(() => {
      attempts += 1
      if (attempts === 1) return createOpaqueTokenRejection(401)
      if (attempts === 2)
        return Response.json(
          {
            error: {
              message: "input item ID does not belong to this connection",
            },
          },
          { status: 401 },
        )
      return createResponsesSuccess(`resp-replay-${attempts}`)
    })
    const payload = (): ResponsesPayload => ({
      ...createResponsesPayload,
      input: [
        { role: "user", content: "hello" },
        {
          type: "reasoning",
          id: "r-1",
          summary: [],
          encrypted_content: "enc-abc",
        },
      ],
    })
    state.responsesReplayLearned.clear()
    try {
      expect(
        await createResponses(payload(), {
          vision: false,
          initiator: "user",
          reasoningReplayIdentity: "rotation",
        }),
      ).toMatchObject({ id: "resp-replay-3" })
      const calls = getFinalCallSnapshots("/responses")
      expect(calls.map(([, init]) => getSessionHeader(init))).toEqual([
        "fusion-stale",
        "auto-current",
        "auto-current",
      ])
      expect(requestBodyText(calls[1][1])).toContain("encrypted_content")
      expect(requestBodyText(calls[2][1])).not.toContain("encrypted_content")
      expect(state.responsesReplayLearned.size).toBe(1)
      const learned = Array.from(state.responsesReplayLearned).join("\n")
      for (const secret of [
        "fusion-stale",
        "auto-current",
        "test-copilot-token",
      ])
        expect(learned).not.toContain(secret)

      await createResponses(payload(), {
        vision: false,
        initiator: "user",
        reasoningReplayIdentity: "rotation",
      })
      const reused = getFinalCallSnapshots("/responses")[3][1]
      expect(getSessionHeader(reused)).toBe("auto-current")
      expect(requestBodyText(reused)).not.toContain("encrypted_content")

      expect(
        registerFusionSelection(
          {
            planVersion: "2" as const,
            fusionPattern: "solo",
            steps: [{ modelId: "gpt-5.3-codex" }],
            sessionToken: "fusion-new",
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
          createProbeCondition({
            source: "fusion",
            planVersion: "2",
            fusionMode: "hydrafusion",
            prompt: "hello",
          }),
        ),
      ).toBe(true)
      await createResponses(payload(), {
        vision: false,
        initiator: "user",
        reasoningReplayIdentity: "rotation",
      })
      const upgraded = getFinalCallSnapshots("/responses")[4][1]
      expect(getSessionHeader(upgraded)).toBe("fusion-new")
      expect(requestBodyText(upgraded)).toContain("encrypted_content")
      expect(state.responsesReplayLearned.size).toBe(1)
    } finally {
      state.responsesReplayLearned.clear()
    }
  })
})
