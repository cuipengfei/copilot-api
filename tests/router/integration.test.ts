import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Script, createContext } from "node:vm"

import {
  createDashboardHandler,
  createRouterHandler,
  createStickyRouterState,
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

async function createDashboardPath(): Promise<string> {
  const dashboardPath = join(
    tmpdir(),
    `sticky-router-dashboard-${crypto.randomUUID()}.html`,
  )
  await Bun.write(
    dashboardPath,
    Bun.file(new URL("../../router/dashboard.html", import.meta.url)),
  )
  return dashboardPath
}

function removeDashboardPath(dashboardPath: string) {
  if (dashboardPath) {
    rmSync(dashboardPath, { force: true })
  }
}

function createState() {
  return createStickyRouterState([
    { name: "alpha", port: 4141 },
    { name: "beta", port: 4142 },
  ])
}

type DashboardInstanceStatus = {
  name: string
  cooldownUntil: string | null
  remainingCooldownMs: number
  upstreamRetryAfter: string | null
}

type DashboardStatusPayload = {
  instances: Array<DashboardInstanceStatus>
}

function isDashboardInstanceStatus(
  value: unknown,
): value is DashboardInstanceStatus {
  if (!value || typeof value !== "object") {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.name === "string"
    && (typeof candidate.cooldownUntil === "string"
      || candidate.cooldownUntil === null)
    && typeof candidate.remainingCooldownMs === "number"
    && (typeof candidate.upstreamRetryAfter === "string"
      || candidate.upstreamRetryAfter === null)
  )
}

function isDashboardStatusPayload(
  value: unknown,
): value is DashboardStatusPayload {
  if (!value || typeof value !== "object") {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    Array.isArray(candidate.instances)
    && candidate.instances.every((item) => isDashboardInstanceStatus(item))
  )
}

function extractInlineScript(html: string): string {
  const scriptOpen = html.indexOf("<script>")
  const scriptClose = html.indexOf("</script>", scriptOpen)
  if (scriptOpen === -1 || scriptClose === -1) {
    throw new TypeError("dashboard inline script missing")
  }

  return html.slice(scriptOpen + "<script>".length, scriptClose).trim()
}

function renderInstancesFromDashboard(
  instances: Array<DashboardInstanceStatus>,
  scriptSource: string,
): string {
  const elements = {
    "sse-status": { textContent: "", className: "" },
    "clear-bindings": {
      addEventListener() {},
      disabled: false,
      textContent: "",
    },
    "clear-history": {
      addEventListener() {},
      disabled: false,
      textContent: "",
    },
    "refresh-usage": {
      addEventListener() {},
      disabled: false,
      textContent: "",
    },
    "instance-count": { textContent: "0" },
    "binding-count": { textContent: "0" },
    "history-count": { textContent: "0" },
    "history-total-usd": { textContent: "(Total: $0.000000)" },
    "history-session-filters": {
      innerHTML: "",
      addEventListener() {},
    },
    "instances-body": {
      innerHTML: "",
      addEventListener() {},
    },
    "bindings-body": { innerHTML: "" },
    "history-body": {
      innerHTML: "",
      addEventListener() {},
    },
  }

  const sandbox = {
    document: {
      getElementById(id: keyof typeof elements) {
        return elements[id]
      },
      querySelectorAll() {
        return []
      },
    },
    window: {
      confirm() {
        return false
      },
      alert() {},
    },
    fetch: (url: string | URL) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            String(url).includes("/api/status") ?
              {
                instances: [],
                sessionBindings: {},
                routeHistorySize: 0,
                totalNanoAiuSinceStart: 0,
              }
            : [],
          ),
      }),
    setInterval: () => 0,
    EventSource: class {
      addEventListener() {}
      onopen: (() => undefined) | null = null
      onerror: (() => undefined) | null = null
      onmessage: ((event: { data: string }) => Promise<void>) | null = null
    },
    console,
  }
  const context = createContext(sandbox)
  const scriptContext = context as typeof sandbox & {
    renderInstances?: (items: Array<DashboardInstanceStatus>) => void
  }

  new Script(scriptSource).runInContext(context)
  const { renderInstances } = scriptContext
  if (typeof renderInstances !== "function") {
    throw new TypeError("dashboard renderInstances missing")
  }

  renderInstances(instances)
  return elements["instances-body"].innerHTML
}

// eslint-disable-next-line max-lines-per-function
describe("router handlers", () => {
  test("router handler serves status and model catalog", async () => {
    const state = createState()
    state.portToModels.set(4141, ["gpt-4.1"])
    state.portToModels.set(4142, ["gpt-4.1", "claude-3.7"])
    state.modelToPorts.set("gpt-4.1", [4141, 4142])
    state.modelToPorts.set("claude-3.7", [4142])

    const handler = createRouterHandler({ state, logger: () => {} })

    const statusRes = await handler(new Request("http://localhost/status"))
    const modelsRes = await handler(new Request("http://localhost/v1/models"))

    expect(await statusRes.json()).toEqual({
      instances: [
        {
          name: "alpha",
          port: 4141,
          models: ["gpt-4.1"],
          healthy: true,
          requestCounts: {},
          lastActive: null,
          cooldownUntil: null,
          remainingCooldownMs: 0,
          upstreamRetryAfter: null,
          headerSnapshot: {
            premiumUsage: null,
            sessionRateLimit: null,
            weeklyRateLimit: null,
          },
          disabled: false,
        },
        {
          name: "beta",
          port: 4142,
          models: ["gpt-4.1", "claude-3.7"],
          healthy: true,
          requestCounts: {},
          lastActive: null,
          cooldownUntil: null,
          remainingCooldownMs: 0,
          upstreamRetryAfter: null,
          headerSnapshot: {
            premiumUsage: null,
            sessionRateLimit: null,
            weeklyRateLimit: null,
          },
          disabled: false,
        },
      ],
      sessionBindings: {},
      modelToPorts: {
        "gpt-4.1": [4141, 4142],
        "claude-3.7": [4142],
      },
      routeHistorySize: 0,
      totalNanoAiuSinceStart: 0,
    })

    const modelsPayload = await modelsRes.json()
    expect(modelsPayload).toEqual({
      object: "list",
      data: [
        { id: "gpt-4.1", object: "model" },
        { id: "claude-3.7", object: "model" },
      ],
    })
  })

  test("router handler preserves sticky routing for repeated session requests", async () => {
    const state = createState()
    const logs: Array<string> = []
    const proxiedPorts: Array<string> = []
    state.modelToPorts.set("gpt-4.1", [4141, 4142])

    const fetchImpl = createFetchStub((input) => {
      proxiedPorts.push(new URL(toInputUrl(input)).port)
      return Promise.resolve(new Response("ok"))
    })

    const handler = createRouterHandler({
      state,
      logger: (line) => logs.push(line),
      fetchImpl,
      now: () => "2026-03-13T00:00:00.000Z",
    })

    const first = await handler(
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
    const second = await handler(
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

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(proxiedPorts[0]).toBe(proxiedPorts[1])
    expect(state.routeHistory.map((entry) => entry.reason)).toEqual([
      "new",
      "sticky",
    ])
    expect(logs[0]).toContain("reason=new")
    expect(logs[1]).toContain("reason=sticky")
  })

  test("router handler uses prompt_cache_key when responses session headers are absent", async () => {
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

    const first = await handler(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oc-agent": "atlas",
          "x-oc-provider": "openai",
        },
        body,
      }),
    )
    const second = await handler(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oc-agent": "atlas",
          "x-oc-provider": "openai",
        },
        body,
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

  test("router handler distributes nomodel requests by least-loaded and rejects unknown models", async () => {
    const state = createState()
    const proxiedPorts: Array<string> = []

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

    const first = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oc-agent": "atlas",
          "x-oc-provider": "openai",
        },
        body: '{"messages":[]}',
      }),
    )
    const second = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oc-agent": "atlas",
          "x-oc-provider": "openai",
        },
        body: '{"messages":[]}',
      }),
    )

    state.modelToPorts.clear()

    const unknown = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oc-agent": "atlas",
          "x-oc-provider": "openai",
        },
        body: '{"model":"does-not-exist"}',
      }),
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(proxiedPorts.sort()).toEqual(["4141", "4142"])
    expect(state.routeHistory.slice(0, 2).map((entry) => entry.reason)).toEqual(
      ["nomodel", "nomodel"],
    )
    expect(unknown.status).toBe(502)
    expect(await unknown.json()).toEqual({
      error: "no instance serves model: does-not-exist",
    })
  })
})

describe("dashboard handler", () => {
  let dashboardPath = ""

  beforeEach(async () => {
    dashboardPath = await createDashboardPath()
  })

  afterEach(() => {
    removeDashboardPath(dashboardPath)
  })

  test("dashboard handler serves html, clears state, and opens an SSE stream", async () => {
    const state = createState()
    const logs: Array<string> = []
    state.routeHistory.push({
      ts: "2026-03-13T00:00:00.000Z",
      sid: "session-1",
      agent: "atlas",
      model: "gpt-4.1",
      provider: "openai",
      port: 4141,
      reason: "new",
      instanceName: "alpha",
    })
    state.sessionBindings.set("session-1:atlas:gpt-4.1", 4141)

    const handler = createDashboardHandler({
      state,
      logger: (line) => logs.push(line),
      dashboardFile: Bun.file(dashboardPath),
    })

    const html = await handler(new Request("http://localhost/"))
    const clearHistory = await handler(
      new Request("http://localhost/api/history/clear", { method: "POST" }),
    )
    const clearBindings = await handler(
      new Request("http://localhost/api/bindings/clear", { method: "POST" }),
    )

    const abortController = new AbortController()
    const events = await handler(
      new Request("http://localhost/api/events", {
        signal: abortController.signal,
      }),
    )
    const reader = events.body?.getReader()
    const firstChunk = reader ? await reader.read() : null
    abortController.abort()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(html.status).toBe(200)
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(await html.text()).toContain("Sticky Router Dashboard")
    expect(await clearHistory.json()).toEqual({ ok: true, cleared: 1 })
    expect(await clearBindings.json()).toEqual({ ok: true, cleared: 1 })
    expect(state.routeHistory).toEqual([])
    expect(state.sessionBindings.size).toBe(0)
    expect(events.headers.get("content-type")).toBe("text/event-stream")
    const firstChunkValue =
      firstChunk && firstChunk.value instanceof Uint8Array ?
        firstChunk.value
      : undefined

    expect(new TextDecoder().decode(firstChunkValue)).toContain("retry: 2000")
    expect(state.sseClients.size).toBe(0)
    expect(logs).toEqual([
      "dashboard cleared route history count=1",
      "dashboard cleared active bindings count=1",
    ])
  })

  test("dashboard html renders local cooldown time, readable remaining duration, and upstream Retry-After", async () => {
    const state = createState()
    const fixedNowMs = new Date("2026-04-19T15:26:09.000Z").getTime()
    const cooldownUntilMs = fixedNowMs + (8 * 60 * 60 + 23 * 60 + 7) * 1000
    state.portCooldownUntil.set(4141, cooldownUntilMs)
    state.portCooldownRetryAfter.set(4141, "30187")

    const handler = createDashboardHandler({
      state,
      logger: () => {},
      dashboardFile: Bun.file(dashboardPath),
      nowMs: () => fixedNowMs,
    })

    const statusResponse = await handler(
      new Request("http://localhost/api/status"),
    )
    const statusPayloadRaw = await statusResponse.json()
    expect(isDashboardStatusPayload(statusPayloadRaw)).toBe(true)
    if (!isDashboardStatusPayload(statusPayloadRaw)) {
      throw new TypeError("unexpected dashboard status payload")
    }

    const statusPayload = statusPayloadRaw
    const alpha = statusPayload.instances.find((item) => item.name === "alpha")

    expect(alpha).toBeDefined()
    if (!alpha) {
      throw new TypeError("alpha instance status missing")
    }

    expect(alpha.name).toBe("alpha")
    expect(typeof alpha.cooldownUntil).toBe("string")
    expect(typeof alpha.remainingCooldownMs).toBe("number")
    expect(alpha.upstreamRetryAfter).toBe("30187")
    expect(alpha.remainingCooldownMs).toBeGreaterThan(0)

    const dashboardResponse = await handler(new Request("http://localhost/"))
    const html = await dashboardResponse.text()

    const scriptContent = extractInlineScript(html)
    const rowsHtml = renderInstancesFromDashboard([alpha], scriptContent)
    const expectedLocalCooldown = new Date(
      alpha.cooldownUntil ?? "",
    ).toLocaleString(undefined, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    })
    expect(rowsHtml).toContain(
      `cooldownLocal: <strong>${expectedLocalCooldown}</strong>`,
    )
    expect(rowsHtml).toContain("remaining: <strong>8h 23m 7s</strong>")
    expect(rowsHtml).toContain(
      `upstreamRetryAfter: <strong>${alpha.upstreamRetryAfter}</strong>`,
    )
  })

  test("dashboard html renders upstream header snapshots for premium/session/weekly", async () => {
    const state = createState()
    state.portHeaderSnapshots.set(4141, {
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

    const handler = createDashboardHandler({
      state,
      logger: () => {},
      dashboardFile: Bun.file(dashboardPath),
    })

    const statusResponse = await handler(
      new Request("http://localhost/api/status"),
    )
    const statusPayloadRaw = await statusResponse.json()
    expect(isDashboardStatusPayload(statusPayloadRaw)).toBe(true)
    if (!isDashboardStatusPayload(statusPayloadRaw)) {
      throw new TypeError("unexpected dashboard status payload")
    }

    const alpha = statusPayloadRaw.instances.find(
      (item) => item.name === "alpha",
    )
    expect(alpha).toBeDefined()
    if (!alpha) {
      throw new TypeError("alpha instance status missing")
    }

    const dashboardResponse = await handler(new Request("http://localhost/"))
    const html = await dashboardResponse.text()
    const scriptContent = extractInlineScript(html)
    const rowsHtml = renderInstancesFromDashboard([alpha], scriptContent)

    expect(rowsHtml).toContain("alpha(u:210.9/t:300)")
    expect(rowsHtml).toContain("session: <strong>5.7 rem @")
    expect(rowsHtml).toContain("weekly: <strong>74.9 rem @")
  })
})
