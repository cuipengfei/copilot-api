import { describe, expect, test } from "bun:test"

import {
  createRouterHandler,
  createStickyRouterState,
  discoverModels,
  proxyTo,
} from "../../router/state"

function createFetchStub(
  handler: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: fetch.preconnect })
}

function toInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input
  }

  if (input instanceof URL) {
    return input.toString()
  }

  return input.url
}

function createState() {
  return createStickyRouterState([
    { name: "alpha", port: 4141 },
    { name: "beta", port: 4142 },
  ])
}

function createRouterRequest(
  body: string,
  headers: Record<string, string> = {},
  url = "http://localhost/v1/messages",
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-oc-agent": "atlas",
      "x-oc-provider": "openai",
      ...headers,
    },
    body,
  })
}

function createResponsesRequest(
  body: string,
  headers: Record<string, string> = {},
): Request {
  return createRouterRequest(body, headers, "http://localhost/v1/responses")
}

function createRouterHandlerForTest(options: {
  state: ReturnType<typeof createState>
  fetchImpl: typeof fetch
  logger?: (line: string) => void
  fixedNowMs?: number
  nowText?: string
}) {
  const fixedNowMs =
    options.fixedNowMs ?? new Date("2026-03-13T00:00:00.000Z").getTime()
  let now: () => string
  if (options.nowText) {
    const nowText = options.nowText
    now = () => nowText
  } else {
    now = () => "2026-03-13T00:00:00.000Z"
  }

  return createRouterHandler({
    state: options.state,
    logger: options.logger ?? (() => {}),
    fetchImpl: options.fetchImpl,
    now,
    nowMs: () => fixedNowMs,
  })
}

async function expectStickySessionRouting(options: {
  state: ReturnType<typeof createState>
  firstRequest: Request
  secondRequest: Request
  expectedSessionId: string
}) {
  const proxiedPorts: Array<string> = []
  const fetchImpl = createFetchStub((input) => {
    proxiedPorts.push(new URL(toInputUrl(input)).port)
    return Promise.resolve(new Response("ok"))
  })
  const handler = createRouterHandlerForTest({
    state: options.state,
    fetchImpl,
  })

  const first = await handler(options.firstRequest)
  const second = await handler(options.secondRequest)

  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(proxiedPorts[0]).toBe(proxiedPorts[1])
  expect(options.state.routeHistory.map((entry) => entry.sid)).toEqual([
    options.expectedSessionId,
    options.expectedSessionId,
  ])
  expect(options.state.routeHistory.map((entry) => entry.reason)).toEqual([
    "new",
    "sticky",
  ])
}

describe("router discovery and proxy helpers", () => {
  test("discoverModels populates model maps and logs failures", async () => {
    const state = createState()
    const logs: Array<string> = []
    const fetchImpl = createFetchStub((input) => {
      const url = toInputUrl(input)

      if (url.includes(":4141/")) {
        return Promise.resolve(
          Response.json({
            data: [{ id: "gpt-4.1" }, { id: "claude-3.7" }],
          }),
        )
      }

      return Promise.reject(new Error("offline"))
    })

    await discoverModels(state, (line) => logs.push(line), fetchImpl)

    expect(state.portToModels.get(4141)).toEqual(["gpt-4.1", "claude-3.7"])
    expect(state.portToModels.has(4142)).toBe(false)
    expect(state.modelToPorts.get("gpt-4.1")).toEqual([4141])
    expect(state.modelToPorts.get("claude-3.7")).toEqual([4141])
    expect(
      logs.some((line) => line.includes("FAILED to discover beta:4142")),
    ).toBe(true)
    expect(logs.at(-1)).toBe("total: 2 unique models across 1 instances")
  })

  test("proxyTo forwards request metadata and returns upstream response", async () => {
    const logs: Array<string> = []
    let targetUrl = ""
    let method = ""
    let forwardedBody = ""
    let forwardedHost: string | null = "unknown"

    const fetchImpl = createFetchStub((input, init) => {
      targetUrl = toInputUrl(input)
      method = init?.method ?? "GET"
      forwardedBody = typeof init?.body === "string" ? init.body : ""
      forwardedHost = new Headers(init?.headers).get("host")

      return Promise.resolve(
        new Response("upstream-ok", {
          status: 201,
          headers: { "x-upstream": "1" },
        }),
      )
    })

    const req = new Request("http://router.local/v1/messages?debug=1", {
      method: "POST",
      headers: {
        host: "router.local",
        "content-type": "application/json",
      },
      body: '{"model":"gpt-4.1"}',
    })

    const res = await proxyTo({
      port: 4141,
      context: {
        body: '{"model":"gpt-4.1"}',
        req,
        url: new URL(req.url),
      },
      logger: (line) => logs.push(line),
      fetchImpl,
    })

    expect(targetUrl).toBe("http://localhost:4141/v1/messages?debug=1")
    expect(method).toBe("POST")
    expect(forwardedBody).toBe('{"model":"gpt-4.1"}')
    expect(forwardedHost).toBeNull()
    expect(logs).toEqual([])
    expect(res.status).toBe(201)
    expect(res.headers.get("x-upstream")).toBe("1")
    expect(await res.text()).toBe("upstream-ok")
  })

  test("proxyTo returns 502 JSON when the upstream fetch fails", async () => {
    const logs: Array<string> = []
    const fetchImpl = createFetchStub(
      () =>
        new Promise<Response>((_, reject) => {
          reject(new Error("connect ECONNREFUSED"))
        }),
    )

    const req = new Request("http://router.local/v1/messages", {
      method: "POST",
      body: '{"model":"gpt-4.1"}',
    })

    const res = await proxyTo({
      port: 4141,
      context: {
        body: '{"model":"gpt-4.1"}',
        req,
        url: new URL(req.url),
      },
      logger: (line) => logs.push(line),
      fetchImpl,
    })

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({
      error: "upstream connection failed on port 4141",
    })
    expect(logs).toEqual(["PROXY ERROR → :4141: connect ECONNREFUSED"])
  })

  test("proxyTo observes quota snapshots from streaming SSE without changing the body", async () => {
    const observedSnapshots: Array<unknown> = []
    const observedUsage: Array<unknown> = []
    const sseBody = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","copilot_quota_snapshots":{"premium_interactions":{"entitlement":"300","overage_count":0,"overage_permitted":true,"percent_remaining":16.2,"reset_date":"2026-06-01T00:00:00Z"}},"copilot_usage":{"total_nano_aiu":123},"response":{"id":"resp_1","usage":{"input_tokens":11}}}\n\n',
    ].join("")
    const fetchImpl = createFetchStub(() =>
      Promise.resolve(
        new Response(sseBody, {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        }),
      ),
    )
    const req = new Request("http://router.local/v1/responses", {
      method: "POST",
      body: '{"model":"gpt-5.5","stream":true}',
    })

    const res = await proxyTo({
      port: 4141,
      context: {
        body: '{"model":"gpt-5.5","stream":true}',
        req,
        url: new URL(req.url),
      },
      logger: () => {},
      fetchImpl,
      onQuotaSnapshots: (quotaSnapshots) =>
        observedSnapshots.push(quotaSnapshots),
      onUsageResolved: (payload) => observedUsage.push(payload),
    })

    expect(await res.text()).toBe(sseBody)
    expect(observedSnapshots).toEqual([
      {
        premium_interactions: {
          entitlement: "300",
          overage_count: 0,
          overage_permitted: true,
          percent_remaining: 16.2,
          reset_date: "2026-06-01T00:00:00Z",
        },
      },
    ])
    expect(observedUsage).toEqual([
      {
        usage: { input_tokens: 11 },
        copilotUsage: { total_nano_aiu: 123 },
      },
    ])
  })

  test("proxyTo extracts copilot usage from response.copilot_usage in SSE response.completed", async () => {
    const observedUsage: Array<unknown> = []
    const sseBody = [
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_2","usage":{"input_tokens":7},"copilot_usage":{"total_nano_aiu":987654}}}\n\n',
    ].join("")
    const fetchImpl = createFetchStub(() =>
      Promise.resolve(
        new Response(sseBody, {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        }),
      ),
    )
    const req = new Request("http://router.local/v1/responses", {
      method: "POST",
      body: '{"model":"claude-sonnet-4.6","stream":true}',
    })

    const res = await proxyTo({
      port: 4141,
      context: {
        body: '{"model":"claude-sonnet-4.6","stream":true}',
        req,
        url: new URL(req.url),
      },
      logger: () => {},
      fetchImpl,
      onUsageResolved: (payload) => observedUsage.push(payload),
    })

    expect(await res.text()).toBe(sseBody)
    expect(observedUsage).toEqual([
      {
        usage: { input_tokens: 7 },
        copilotUsage: { total_nano_aiu: 987654 },
      },
    ])
  })

  test("proxyTo extracts nested usage from SSE response.incomplete", async () => {
    const observedUsage: Array<unknown> = []
    const sseBody =
      'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"usage":{"input_tokens":7},"copilot_usage":{"total_nano_aiu":654321}}}\n\n'
    const fetchImpl = createFetchStub(() =>
      Promise.resolve(
        new Response(sseBody, {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        }),
      ),
    )
    const req = new Request("http://router.local/v1/responses", {
      method: "POST",
      body: '{"model":"gemini-3.6-flash","stream":true}',
    })

    const res = await proxyTo({
      port: 4141,
      context: {
        body: '{"model":"gemini-3.6-flash","stream":true}',
        req,
        url: new URL(req.url),
      },
      logger: () => {},
      fetchImpl,
      onUsageResolved: (payload) => observedUsage.push(payload),
    })

    expect(await res.text()).toBe(sseBody)
    expect(observedUsage).toEqual([
      {
        usage: { input_tokens: 7 },
        copilotUsage: { total_nano_aiu: 654321 },
      },
    ])
  })

  test("proxyTo extracts top-level usage from Chat Completions SSE", async () => {
    const observedUsage: Array<unknown> = []
    const sseBody = [
      'data: {"id":"chatcmpl_1","choices":[],"copilot_usage":{"total_nano_aiu":456789}}\n\n',
      'data: {"id":"chatcmpl_1","choices":[],"usage":{"prompt_tokens":7,"prompt_tokens_details":{"cached_tokens":5}},"copilot_usage":{"total_nano_aiu":null}}\n\n',
    ].join("")
    const fetchImpl = createFetchStub(() =>
      Promise.resolve(
        new Response(sseBody, {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        }),
      ),
    )
    const req = new Request("http://router.local/v1/chat/completions", {
      method: "POST",
      body: '{"model":"gemini-3.6-flash","stream":true}',
    })

    const res = await proxyTo({
      port: 4141,
      context: {
        body: '{"model":"gemini-3.6-flash","stream":true}',
        req,
        url: new URL(req.url),
      },
      logger: () => {},
      fetchImpl,
      onUsageResolved: (payload) => observedUsage.push(payload),
    })

    expect(await res.text()).toBe(sseBody)
    expect(observedUsage).toEqual([
      {
        usage: {
          prompt_tokens: 7,
          prompt_tokens_details: { cached_tokens: 5 },
        },
        copilotUsage: { total_nano_aiu: 456789 },
      },
    ])
  })

  test("proxyTo extracts usage from non-streaming JSON responses", async () => {
    const observedUsage: Array<unknown> = []
    const fetchImpl = createFetchStub(() =>
      Promise.resolve(
        Response.json({
          id: "resp-json",
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 2 },
          },
          copilot_usage: {
            total_nano_aiu: 3,
          },
        }),
      ),
    )
    const req = new Request("http://router.local/v1/responses", {
      method: "POST",
      body: '{"model":"gpt-5.5","stream":false}',
    })

    const res = await proxyTo({
      port: 4141,
      context: {
        body: '{"model":"gpt-5.5","stream":false}',
        req,
        url: new URL(req.url),
      },
      logger: () => {},
      fetchImpl,
      onUsageResolved: (payload) => observedUsage.push(payload),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: "resp-json",
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 2 },
      },
      copilot_usage: {
        total_nano_aiu: 3,
      },
    })
    expect(observedUsage).toEqual([
      {
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 2 },
        },
        copilotUsage: {
          total_nano_aiu: 3,
        },
      },
    ])
  })
  test("router handler keeps sticky routing for Claude Code session header case-insensitively", async () => {
    const state = createState()
    state.modelToPorts.set("gpt-4.1", [4141, 4142])

    await expectStickySessionRouting({
      state,
      firstRequest: createRouterRequest('{"model":"gpt-4.1"}', {
        "X-Claude-Code-Session-Id": "claude-session-1",
      }),
      secondRequest: createRouterRequest('{"model":"gpt-4.1"}', {
        "x-Claude-Code-SESSION-id": "claude-session-1",
      }),
      expectedSessionId: "claude-session-1",
    })
  })

  test("router handler keeps sticky routing for Codex fallback session headers case-insensitively", async () => {
    const body = JSON.stringify({
      model: "gpt-5.4",
      prompt_cache_key: "responses-session-1",
      input: [{ role: "user", content: "hello" }],
    })

    const testCases: Array<{
      firstHeaders: Record<string, string>
      secondHeaders: Record<string, string>
      expectedSessionId: string
    }> = [
      {
        firstHeaders: { "session-id": "codex-session-1" },
        secondHeaders: { "SESSION-ID": "codex-session-1" },
        expectedSessionId: "codex-session-1",
      },
      {
        firstHeaders: { session_id: "codex-session-2" },
        secondHeaders: { SESSION_ID: "codex-session-2" },
        expectedSessionId: "codex-session-2",
      },
    ]

    for (const testCase of testCases) {
      const state = createState()
      state.modelToPorts.set("gpt-5.4", [4141, 4142])

      await expectStickySessionRouting({
        state,
        firstRequest: createResponsesRequest(body, testCase.firstHeaders),
        secondRequest: createResponsesRequest(body, testCase.secondHeaders),
        expectedSessionId: testCase.expectedSessionId,
      })
    }
  })

  test("router handler prefers x-session-id over compatible fallback headers case-insensitively", async () => {
    const state = createState()
    state.modelToPorts.set("gpt-4.1", [4141, 4142])

    const fetchImpl = createFetchStub(() => Promise.resolve(new Response("ok")))

    const handler = createRouterHandler({
      state,
      logger: () => {},
      fetchImpl,
      now: () => "2026-03-13T00:00:00.000Z",
    })

    const response = await handler(
      createRouterRequest(
        '{"model":"gpt-4.1","prompt_cache_key":"body-session"}',
        {
          "X-SESSION-ID": "preferred-session",
          "X-Claude-Code-Session-Id": "claude-session-1",
          "SESSION-ID": "codex-session-1",
        },
      ),
    )

    expect(response.status).toBe(200)
    expect(state.routeHistory.at(-1)?.sid).toBe("preferred-session")
    expect(state.sessionBindings.has("preferred-session:atlas:gpt-4.1")).toBe(
      true,
    )
  })

  test("router handler uses prompt_cache_key when session headers are absent", async () => {
    const state = createState()
    const proxiedPorts: Array<string> = []
    state.modelToPorts.set("gpt-5.4", [4141, 4142])

    const fetchImpl = createFetchStub((input) => {
      proxiedPorts.push(new URL(toInputUrl(input)).port)
      return Promise.resolve(new Response("ok"))
    })

    const handler = createRouterHandler({
      state,
      logger: () => {},
      fetchImpl,
      now: () => "2026-03-13T00:00:00.000Z",
    })

    const body = JSON.stringify({
      model: "gpt-5.4",
      prompt_cache_key: "responses-session-1",
      input: [{ role: "user", content: "hello" }],
    })

    const first = await handler(createResponsesRequest(body))
    const second = await handler(
      createResponsesRequest(body, {
        "thread-id": "thread-only-1",
      }),
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(proxiedPorts[0]).toBe(proxiedPorts[1])
    expect(state.routeHistory.map((entry) => entry.sid)).toEqual([
      "responses-session-1",
      "responses-session-1",
    ])
    expect(state.routeHistory.map((entry) => entry.reason)).toEqual([
      "new",
      "sticky",
    ])
  })
  test("router handler ignores blank prompt_cache_key", async () => {
    const state = createState()
    state.modelToPorts.set("gpt-5.4", [4141])
    const handler = createRouterHandlerForTest({
      state,
      fetchImpl: createFetchStub(() => Promise.resolve(new Response("ok"))),
    })

    const response = await handler(
      createResponsesRequest(
        JSON.stringify({ model: "gpt-5.4", prompt_cache_key: "   " }),
      ),
    )

    expect(response.status).toBe(200)
    expect(state.routeHistory.at(-1)?.sid).toBe("-")
    expect(state.sessionBindings.size).toBe(0)
  })
})

// eslint-disable-next-line max-lines-per-function
describe("router handler cooldown semantics", () => {
  test("router handler retries another instance on upstream 402 quota_exceeded", async () => {
    const state = createState()
    state.modelToPorts.set("gpt-4.1", [4141, 4142])
    state.sessionBindings.set("session-1:atlas:gpt-4.1", 4141)
    const fixedNowMs = new Date("2026-03-13T00:00:00.000Z").getTime()

    const fetchImpl = createFetchStub((input) => {
      const port = new URL(toInputUrl(input)).port
      if (port === "4141") {
        return Promise.resolve(
          new Response(
            '{"error":{"message":"You have exceeded your monthly quota","code":"quota_exceeded"}}',
            { status: 402 },
          ),
        )
      }
      return Promise.resolve(new Response("ok", { status: 200 }))
    })

    const handler = createRouterHandlerForTest({ state, fetchImpl, fixedNowMs })

    const res = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "session-1",
          "x-oc-agent": "atlas",
          "x-oc-provider": "openai",
        },
        body: '{"model":"gpt-4.1"}',
      }),
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
    expect(state.portCooldownUntil.get(4141)).toBeGreaterThan(fixedNowMs)
    expect(state.sessionBindings.get("session-1:atlas:gpt-4.1")).toBe(4142)
  })

  test("router handler sets cooldown on upstream 429 using Retry-After seconds", async () => {
    const state = createState()
    state.modelToPorts.set("gpt-4.1", [4141, 4142])
    state.sessionBindings.set("session-1:atlas:gpt-4.1", 4141)
    const logs: Array<string> = []
    const fixedNowMs = new Date("2026-03-13T00:00:00.000Z").getTime()

    const fetchImpl = createFetchStub((input) => {
      const port = new URL(toInputUrl(input)).port
      if (port === "4141") {
        return Promise.resolve(
          new Response("too-many", {
            status: 429,
            headers: { "Retry-After": "7" },
          }),
        )
      }
      return Promise.resolve(new Response("ok", { status: 200 }))
    })

    const handler = createRouterHandlerForTest({
      state,
      logger: (line) => logs.push(line),
      fetchImpl,
      fixedNowMs,
    })

    const res = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "session-1",
          "x-oc-agent": "atlas",
          "x-oc-provider": "openai",
        },
        body: '{"model":"gpt-4.1"}',
      }),
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
    expect(state.portCooldownUntil.get(4141)).toBe(fixedNowMs + 7000)
    expect(state.portCooldownRetryAfter.get(4141)).toBe("7")
    expect(state.portHeaderSnapshots.get(4141)).toEqual({
      premiumUsage: null,
      sessionRateLimit: null,
      weeklyRateLimit: null,
    })
    expect(logs.some((line) => line.includes("cooldown"))).toBe(true)
  })

  test("router handler excludes cooling ports on nomodel least-loaded path", async () => {
    const state = createState()
    const fixedNowMs = new Date("2026-03-13T00:00:00.000Z").getTime()
    state.portCooldownUntil.set(4141, fixedNowMs + 30_000)

    let proxiedPort = ""
    const fetchImpl = createFetchStub((input) => {
      proxiedPort = new URL(toInputUrl(input)).port
      return Promise.resolve(new Response("ok", { status: 200 }))
    })

    const handler = createRouterHandlerForTest({
      state,
      fetchImpl,
      fixedNowMs,
    })

    const res = await handler(createRouterRequest("{}"))

    expect(res.status).toBe(200)
    expect(proxiedPort).toBe("4142")
    expect(state.portHeaderSnapshots.get(4142)).toEqual({
      premiumUsage: null,
      sessionRateLimit: null,
      weeklyRateLimit: null,
    })
  })

  test("router handler records cooldown on nomodel upstream 429", async () => {
    const state = createState()
    const fixedNowMs = new Date("2026-03-13T00:00:00.000Z").getTime()
    state.portCooldownUntil.set(4142, fixedNowMs + 30_000)

    const fetchImpl = createFetchStub(() =>
      Promise.resolve(
        new Response("too-many", {
          status: 429,
          headers: { "Retry-After": "5" },
        }),
      ),
    )

    const handler = createRouterHandlerForTest({
      state,
      fetchImpl,
      fixedNowMs,
    })

    const res = await handler(createRouterRequest("{}"))

    expect(res.status).toBe(429)
    expect(state.portCooldownUntil.get(4141)).toBe(fixedNowMs + 5000)
  })

  test("router handler captures upstream quota headers into header snapshot", async () => {
    const state = createState()
    state.modelToPorts.set("gpt-4.1", [4141])

    const fetchImpl = createFetchStub(() =>
      Promise.resolve(
        new Response("ok", {
          status: 200,
          headers: {
            "x-quota-snapshot-premium_interactions":
              "ent=300&ov=0.0&ovPerm=false&rem=29.7&rst=2026-05-01T00%3A00%3A00Z",
            "x-usage-ratelimit-session":
              "ent=0&ov=0.0&ovPerm=false&rem=5.7&rst=2026-04-21T06%3A35%3A37Z",
            "x-usage-ratelimit-weekly":
              "ent=0&ov=0.0&ovPerm=false&rem=74.9&rst=2026-04-27T00%3A00%3A00Z",
          },
        }),
      ),
    )

    const handler = createRouterHandlerForTest({
      state,
      fetchImpl,
    })

    const res = await handler(createRouterRequest('{"model":"gpt-4.1"}'))

    expect(res.status).toBe(200)
    expect(state.portHeaderSnapshots.get(4141)).toEqual({
      premiumUsage: { used: 210.9, total: 300 },
      sessionRateLimit: {
        remaining: 5.7,
        resetAt: "2026-04-21T06:35:37Z",
      },
      weeklyRateLimit: {
        remaining: 74.9,
        resetAt: "2026-04-27T00:00:00Z",
      },
    })
  })

  test("router handler captures streaming response quota snapshots into header snapshot", async () => {
    const state = createState()
    state.modelToPorts.set("gpt-5.5", [4141])
    const fetchImpl = createFetchStub(() =>
      Promise.resolve(
        new Response(
          [
            'event: response.created\ndata: {"type":"response.created"}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","copilot_quota_snapshots":{"premium_interactions":{"entitlement":"300","overage_count":0,"overage_permitted":true,"percent_remaining":16.2,"reset_date":"2026-06-01T00:00:00Z"},"5Hour-Session-RateLimits":{"entitlement":"0","overage_count":0,"overage_permitted":false,"percent_remaining":76.6,"reset_date":"2026-05-26T18:23:09Z"},"Weekly-Session-RateLimits":{"entitlement":"0","overage_count":0,"overage_permitted":false,"percent_remaining":82.6,"reset_date":"2026-06-01T00:00:00Z"}},"response":{"id":"resp_1","usage":null}}\n\n',
          ].join(""),
          {
            headers: { "content-type": "text/event-stream" },
          },
        ),
      ),
    )
    const handler = createRouterHandlerForTest({
      state,
      fetchImpl,
    })

    const res = await handler(
      createRouterRequest('{"model":"gpt-5.5","stream":true}'),
    )

    expect(res.status).toBe(200)
    await res.text()
    expect(state.portHeaderSnapshots.get(4141)).toEqual({
      premiumUsage: { used: 251.4, total: 300 },
      sessionRateLimit: {
        remaining: 76.6,
        resetAt: "2026-05-26T18:23:09Z",
      },
      weeklyRateLimit: {
        remaining: 82.6,
        resetAt: "2026-06-01T00:00:00Z",
      },
    })
  })

  test("router handler cools down instance when 200 SSE stream carries quota_exceeded error", async () => {
    const state = createState()
    state.modelToPorts.set("gpt-5.5", [4141])
    const fixedNowMs = new Date("2026-03-13T00:00:00.000Z").getTime()

    const fetchImpl = createFetchStub(() =>
      Promise.resolve(
        new Response(
          [
            'event: error\ndata: {"type":"error","error":{"code":"quota_exceeded","message":"You have exceeded your monthly quota"},"code":"quota_exceeded","message":"You have exceeded your monthly quota"}\n\n',
          ].join(""),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      ),
    )
    const handler = createRouterHandlerForTest({
      state,
      fetchImpl,
      fixedNowMs,
    })

    const res = await handler(
      createRouterRequest('{"model":"gpt-5.5","stream":true}'),
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toContain("quota_exceeded")
    expect(state.portCooldownUntil.get(4141)).toBe(fixedNowMs + 18_000_000)
    expect(state.portCooldownRetryAfter.get(4141)).toBeNull()
  })

  test("router handler returns 503 on nomodel when all instances are cooling", async () => {
    const state = createState()
    const fixedNowMs = new Date("2026-03-13T00:00:00.000Z").getTime()
    state.portCooldownUntil.set(4141, fixedNowMs + 3000)
    state.portCooldownUntil.set(4142, fixedNowMs + 5000)

    let proxied = false
    const fetchImpl = createFetchStub(() => {
      proxied = true
      return Promise.resolve(new Response("ok", { status: 200 }))
    })

    const handler = createRouterHandlerForTest({
      state,
      fetchImpl,
      fixedNowMs,
    })

    const res = await handler(createRouterRequest("{}"))

    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("3")
    expect(await res.json()).toEqual({
      error: "all upstream instances are cooling down for nomodel routing",
    })
    expect(proxied).toBe(false)
  })

  test("router handler uses default cooldown when Retry-After is invalid", async () => {
    const state = createState()
    state.modelToPorts.set("gpt-4.1", [4141])
    const fixedNowMs = new Date("2026-03-13T00:00:00.000Z").getTime()

    const fetchImpl = createFetchStub(() =>
      Promise.resolve(
        new Response("too-many", {
          status: 429,
          headers: { "Retry-After": "invalid" },
        }),
      ),
    )

    const handler = createRouterHandlerForTest({
      state,
      fetchImpl,
      fixedNowMs,
    })

    const res = await handler(createRouterRequest('{"model":"gpt-4.1"}'))

    expect(res.status).toBe(503)
    expect(state.portCooldownUntil.get(4141)).toBe(fixedNowMs + 18_000_000)
    expect(state.portCooldownRetryAfter.get(4141)).toBe("invalid")
  })

  test("router handler parses Retry-After http-date on upstream 429", async () => {
    const state = createState()
    state.modelToPorts.set("gpt-4.1", [4141])
    const fixedNowMs = new Date("2026-03-13T00:00:00.000Z").getTime()

    const retryAfter = "Fri, 13 Mar 2026 00:00:05 GMT"
    const fetchImpl = createFetchStub(() =>
      Promise.resolve(
        new Response("too-many", {
          status: 429,
          headers: { "Retry-After": retryAfter },
        }),
      ),
    )

    const handler = createRouterHandlerForTest({
      state,
      fetchImpl,
      fixedNowMs,
    })

    const res = await handler(createRouterRequest('{"model":"gpt-4.1"}'))

    expect(res.status).toBe(503)
    expect(state.portCooldownUntil.get(4141)).toBe(
      new Date("2026-03-13T00:00:05.000Z").getTime(),
    )
    expect(state.portCooldownRetryAfter.get(4141)).toBe(retryAfter)
  })

  test("router handler returns 503 with min Retry-After when all candidates are cooling", async () => {
    const state = createState()
    state.modelToPorts.set("gpt-4.1", [4141, 4142])
    const fixedNowMs = new Date("2026-03-13T00:00:00.000Z").getTime()
    state.portCooldownUntil.set(4141, fixedNowMs + 3000)
    state.portCooldownUntil.set(4142, fixedNowMs + 5000)

    let proxied = false
    const fetchImpl = createFetchStub(() => {
      proxied = true
      return Promise.resolve(new Response("ok", { status: 200 }))
    })

    const handler = createRouterHandlerForTest({
      state,
      fetchImpl,
      fixedNowMs,
    })

    const res = await handler(createRouterRequest('{"model":"gpt-4.1"}'))

    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("3")
    expect(await res.json()).toEqual({
      error: "all upstream instances are cooling down for model: gpt-4.1",
    })
    expect(proxied).toBe(false)
  })
})
