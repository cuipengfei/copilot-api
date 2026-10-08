import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"
import type { ResponsesPayload } from "~/lib/types/responses"

import {
  invalidateAutoSession,
  prewarmAutoSession,
} from "../src/lib/auto-session"
import { HTTPError } from "../src/lib/error"
import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"
import { createMessages } from "../src/services/copilot/create-messages"
import { createResponses } from "../src/services/copilot/create-responses"
import type { AutoSelectionResponse } from "../src/services/copilot/get-auto-selection"

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

const wireFetchMock = (
  finalResponseFactory: () => Response,
): ReturnType<typeof mock> => {
  const REQUEST_CAP = 32
  let requestCount = 0
  const fetchMock = mock((url: string, init?: RequestInit) => {
    requestCount += 1
    if (requestCount > REQUEST_CAP) {
      return Promise.reject(new Error("chain request cap exceeded"))
    }
    if (url.includes("/auto")) {
      const currentQueue = (
        globalThis as unknown as {
          __AUTO_SESSION_QUEUE__?: Array<AutoSelectionResponse>
        }
      ).__AUTO_SESSION_QUEUE__
      const nextPayload = currentQueue?.shift()
      if (!nextPayload) throw new Error("missing queued /auto response")
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
  new Response("opaque upstream failure without any known keyword", { status })

const queuePrewarmPlusRefresh = (endpoint: string): void => {
  ;(
    globalThis as unknown as {
      __AUTO_SESSION_QUEUE__: Array<AutoSelectionResponse>
    }
  ).__AUTO_SESSION_QUEUE__.push(
    queuedAutoSelection("gpt-5.3-codex", "session-stale", [endpoint]),
    // 启动发现消耗 8 个探测点：stale + 7 填充，fresh 留待 re-acquire
    ...Array.from({ length: 7 }, (_, i) =>
      queuedAutoSelection(`filler-${i}`, `session-filler-${i}`, [endpoint]),
    ),
    queuedAutoSelection("gpt-5.3-codex", "session-fresh", [endpoint]),
  )
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
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.forceAgent = false
  state.models = undefined
  state.interactionId = "test-interaction-id"
})

afterEach(() => {
  invalidateAutoSession()
  mock.restore()
})

describe("auto-session token injection across chains", () => {
  test("messages chain adds Copilot-Session-Token when model is covered", async () => {
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
    await createMessages(createMessagesPayload, undefined, {
      initiator: "user",
    })

    const [, init] = findCall(fetchMock, "/v1/messages")
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

    expect(fetchMock).toHaveBeenCalledTimes(8)
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
    queuePrewarmPlusRefresh("/responses")
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

  test("responses chain retries opaque 401 once via re-acquired session", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<AutoSelectionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedAutoSelection("gpt-5.3-codex", "session-stale", ["/responses"]),
      // 启动发现消耗 8 个探测点：stale + 7 填充，fresh 留待 refresh
      ...Array.from({ length: 7 }, (_, i) =>
        queuedAutoSelection(`filler-${i}`, `session-filler-${i}`, [
          "/responses",
        ]),
      ),
      queuedAutoSelection("gpt-5.3-codex", "session-fresh", ["/responses"]),
    )

    let responseAttempt = 0
    wireFetchMock(() => {
      responseAttempt += 1
      // 首响应当 401 且正文不含任何旧关键字：触发条件只看 token+状态码
      if (responseAttempt === 1) {
        return createOpaqueTokenRejection(401)
      }
      return createResponsesSuccess("resp-retried")
    })

    await prewarmAutoSession()
    const result = (await createResponses(createResponsesPayload, {
      vision: false,
      initiator: "user",
    })) as { id: string }

    const responseCalls = getFinalCallSnapshots("/responses")
    expect(responseCalls).toHaveLength(2)
    expect(getSessionHeader(responseCalls[0][1])).toBe("session-stale")
    expect(getSessionHeader(responseCalls[1][1])).toBe("session-fresh")
    // payload.model 始终为原模型 ID（含重试包）
    for (const [, init] of responseCalls) {
      const body = JSON.parse(requestBodyText(init)) as { model: string }
      expect(body.model).toBe("gpt-5.3-codex")
    }
    expect(result.id).toBe("resp-retried")
  })

  test("responses chain does not retry opaque 401 more than once", async () => {
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<AutoSelectionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedAutoSelection("gpt-5.3-codex", "session-stale", ["/responses"]),
      // 启动发现消耗 8 个探测点：stale + 7 填充，fresh 留待 refresh
      ...Array.from({ length: 7 }, (_, i) =>
        queuedAutoSelection(`filler-${i}`, `session-filler-${i}`, [
          "/responses",
        ]),
      ),
      queuedAutoSelection("gpt-5.3-codex", "session-fresh", ["/responses"]),
    )

    // 首、次响应均为 401 且无旧关键字正文：第二次失败必须原样 HTTPError
    wireFetchMock(() => createOpaqueTokenRejection(401))

    await prewarmAutoSession()
    try {
      await createResponses(createResponsesPayload, {
        vision: false,
        initiator: "user",
      })
      expect.unreachable("Expected token rejection retry to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
    }

    const responseCalls = getFinalCallSnapshots("/responses")
    expect(responseCalls).toHaveLength(2)
    expect(getSessionHeader(responseCalls[0][1])).toBe("session-stale")
    expect(getSessionHeader(responseCalls[1][1])).toBe("session-fresh")
  })

  test("responses chain does not retry 401 without session token or refresh /auto", async () => {
    // 只给一个其它模型的配对：gpt-5.3-codex 未覆盖 → 请求不附 session token
    ;(
      globalThis as unknown as {
        __AUTO_SESSION_QUEUE__: Array<AutoSelectionResponse>
      }
    ).__AUTO_SESSION_QUEUE__.push(
      queuedAutoSelection("other-model", "session-miss", ["/responses"]),
    )

    const fetchMock = wireFetchMock(() => createOpaqueTokenRejection(401))

    await prewarmAutoSession()
    const autoCallsAfterPrewarm = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/auto"),
    ).length

    try {
      await createResponses(createResponsesPayload, {
        vision: false,
        initiator: "user",
      })
      expect.unreachable("Expected 401 without token to propagate")
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
    }

    const responseCalls = getFinalCallSnapshots("/responses")
    expect(responseCalls).toHaveLength(1)
    expect(getSessionHeader(responseCalls[0][1])).toBeUndefined()
    const autoCallsAfterRequest = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/auto"),
    ).length
    expect(autoCallsAfterRequest).toBe(autoCallsAfterPrewarm)
  })

  test("chat-completions chain retries opaque 401 once via re-acquired session", async () => {
    queuePrewarmPlusRefresh("/chat/completions")

    let responseAttempt = 0
    const fetchMock = wireFetchMock(() => {
      responseAttempt += 1
      if (responseAttempt === 1) return createOpaqueTokenRejection(401)
      return createChatSuccess("chat-retried")
    })

    await prewarmAutoSession()
    const autoBefore = countAutoCalls(fetchMock)
    const result = (await createChatCompletions(createChatPayload)) as {
      id: string
    }

    const chatCalls = getFinalCallSnapshots("/chat/completions")
    expect(chatCalls).toHaveLength(2)
    expect(getSessionHeader(chatCalls[0][1])).toBe("session-stale")
    expect(getSessionHeader(chatCalls[1][1])).toBe("session-fresh")
    for (const [, init] of chatCalls) {
      const body = JSON.parse(requestBodyText(init)) as { model: string }
      expect(body.model).toBe("gpt-5.3-codex")
    }
    // /auto 刷新至多一次（re-acquire），不多刷
    expect(countAutoCalls(fetchMock) - autoBefore).toBe(1)
    expect(result.id).toBe("chat-retried")
  })

  test("chat-completions chain retries opaque 400 once via re-acquired session", async () => {
    queuePrewarmPlusRefresh("/chat/completions")

    let responseAttempt = 0
    const fetchMock = wireFetchMock(() => {
      responseAttempt += 1
      if (responseAttempt === 1) return createOpaqueTokenRejection(400)
      return createChatSuccess("chat-retried")
    })

    await prewarmAutoSession()
    const autoBefore = countAutoCalls(fetchMock)
    const result = (await createChatCompletions(createChatPayload)) as {
      id: string
    }

    const chatCalls = getFinalCallSnapshots("/chat/completions")
    expect(chatCalls).toHaveLength(2)
    expect(getSessionHeader(chatCalls[0][1])).toBe("session-stale")
    expect(getSessionHeader(chatCalls[1][1])).toBe("session-fresh")
    for (const [, init] of chatCalls) {
      const body = JSON.parse(requestBodyText(init)) as { model: string }
      expect(body.model).toBe("gpt-5.3-codex")
    }
    expect(countAutoCalls(fetchMock) - autoBefore).toBe(1)
    expect(result.id).toBe("chat-retried")
  })

  test("chat-completions chain keeps HTTPError when opaque 401 persists", async () => {
    queuePrewarmPlusRefresh("/chat/completions")
    const fetchMock = wireFetchMock(() => createOpaqueTokenRejection(401))

    await prewarmAutoSession()
    const autoBefore = countAutoCalls(fetchMock)
    try {
      await createChatCompletions(createChatPayload)
      expect.unreachable("Expected persistent 401 to propagate as HTTPError")
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
    }

    // 第二次失败原样走错误路径：总实际请求恰 2，不第三次重试
    expect(getFinalCallSnapshots("/chat/completions")).toHaveLength(2)
    expect(countAutoCalls(fetchMock) - autoBefore).toBe(1)
  })

  test("messages chain retries opaque 401 once via re-acquired session", async () => {
    queuePrewarmPlusRefresh("/v1/messages")

    let responseAttempt = 0
    const fetchMock = wireFetchMock(() => {
      responseAttempt += 1
      if (responseAttempt === 1) return createOpaqueTokenRejection(401)
      return createMessagesSuccess("msg-retried")
    })

    await prewarmAutoSession()
    const autoBefore = countAutoCalls(fetchMock)
    const result = await createMessages(createMessagesPayload, undefined, {
      initiator: "user",
    })

    const messageCalls = getFinalCallSnapshots("/v1/messages")
    expect(messageCalls).toHaveLength(2)
    expect(getSessionHeader(messageCalls[0][1])).toBe("session-stale")
    expect(getSessionHeader(messageCalls[1][1])).toBe("session-fresh")
    for (const [, init] of messageCalls) {
      const body = JSON.parse(requestBodyText(init)) as { model: string }
      expect(body.model).toBe("gpt-5.3-codex")
    }
    expect(countAutoCalls(fetchMock) - autoBefore).toBe(1)
    const body = result as { id: string }
    expect(body.id).toBe("msg-retried")
  })

  test("messages chain retries opaque 400 once via re-acquired session", async () => {
    queuePrewarmPlusRefresh("/v1/messages")

    let responseAttempt = 0
    const fetchMock = wireFetchMock(() => {
      responseAttempt += 1
      if (responseAttempt === 1) return createOpaqueTokenRejection(400)
      return createMessagesSuccess("msg-retried")
    })

    await prewarmAutoSession()
    const autoBefore = countAutoCalls(fetchMock)
    const result = await createMessages(createMessagesPayload, undefined, {
      initiator: "user",
    })

    const messageCalls = getFinalCallSnapshots("/v1/messages")
    expect(messageCalls).toHaveLength(2)
    expect(getSessionHeader(messageCalls[0][1])).toBe("session-stale")
    expect(getSessionHeader(messageCalls[1][1])).toBe("session-fresh")
    for (const [, init] of messageCalls) {
      const body = JSON.parse(requestBodyText(init)) as { model: string }
      expect(body.model).toBe("gpt-5.3-codex")
    }
    expect(countAutoCalls(fetchMock) - autoBefore).toBe(1)
    const body = result as { id: string }
    expect(body.id).toBe("msg-retried")
  })

  test("messages chain keeps HTTPError when opaque 400 persists", async () => {
    queuePrewarmPlusRefresh("/v1/messages")
    const fetchMock = wireFetchMock(() => createOpaqueTokenRejection(400))

    await prewarmAutoSession()
    const autoBefore = countAutoCalls(fetchMock)
    try {
      await createMessages(createMessagesPayload, undefined, {
        initiator: "user",
      })
      expect.unreachable("Expected persistent 400 to propagate as HTTPError")
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
    }

    // 第二次失败原样走错误路径：总实际请求恰 2，不第三次重试
    expect(getFinalCallSnapshots("/v1/messages")).toHaveLength(2)
    expect(countAutoCalls(fetchMock) - autoBefore).toBe(1)
  })

  test.each([
    { forceAgent: false, expectedInitiator: "user" },
    { forceAgent: true, expectedInitiator: "agent" },
  ])(
    "chat-completions chain honors -F=$forceAgent with auto token retry (initiator=$expectedInitiator)",
    async ({ forceAgent, expectedInitiator }) => {
      const previousForceAgent = state.forceAgent
      const previousDecision = state.smartAgentDecision
      const previousCacheTimestamp = state.smartAgentCacheTimestamp
      state.forceAgent = forceAgent
      if (forceAgent) {
        // 预置有效缓存（forceAgent=true 决策 + 新鲜时间戳）：
        // getDecisionWithSmartCache 命中缓存，绝不查询真实配额服务
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
        queuePrewarmPlusRefresh("/chat/completions")

        let responseAttempt = 0
        const fetchMock = wireFetchMock(() => {
          responseAttempt += 1
          if (responseAttempt === 1) return createOpaqueTokenRejection(401)
          return createChatSuccess("chat-force-agent")
        })

        await prewarmAutoSession()
        const result = (await createChatCompletions(createChatPayload)) as {
          id: string
        }

        const chatCalls = getFinalCallSnapshots("/chat/completions")
        expect(chatCalls).toHaveLength(2)
        expect(getSessionHeader(chatCalls[0][1])).toBe("session-stale")
        expect(getSessionHeader(chatCalls[1][1])).toBe("session-fresh")
        for (const [, init] of chatCalls) {
          const body = JSON.parse(requestBodyText(init)) as { model: string }
          expect(body.model).toBe("gpt-5.3-codex")
          expect((init.headers as Record<string, string>)["x-initiator"]).toBe(
            expectedInitiator,
          )
        }
        expect(result.id).toBe("chat-force-agent")

        // 严禁真实配额服务：两个分支全程零 copilot_internal/user 请求
        const quotaCalls = fetchMock.mock.calls.filter((call) =>
          String(call[0]).includes("copilot_internal/user"),
        )
        expect(quotaCalls).toHaveLength(0)
      } finally {
        state.forceAgent = previousForceAgent
        state.smartAgentDecision = previousDecision
        state.smartAgentCacheTimestamp = previousCacheTimestamp
        invalidateAutoSession()
      }
    },
  )
})
